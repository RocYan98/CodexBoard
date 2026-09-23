use std::{
    ffi::{CString, OsStr},
    fs::File,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path, PathBuf},
    time::Duration,
};

const NAME: &str = "CodexBoard";
// Published releases before the project rename stored the complete data tree here.
const LEGACY_NAMES: [&str; 2] = ["Lark-Codex", "Lark Codex Taskboard"];

pub fn path(home: &Path) -> PathBuf {
    home.join("Library/Application Support").join(NAME)
}

fn cstring(name: &OsStr) -> Result<CString, String> {
    CString::new(name.as_bytes()).map_err(|_| "应用数据路径无效".into())
}

fn directory(parent: RawFd, name: &OsStr, create: bool) -> Result<OwnedFd, String> {
    let name = cstring(name)?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 && create && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err("无法创建应用数据目录，请检查目录权限".into());
        }
        fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    }
    if fd < 0 {
        return Err("应用数据目录不可访问或含符号链接，现有内容已保留".into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn identity(parent: RawFd, name: &str) -> Result<Option<(u64, u64)>, String> {
    let name = CString::new(name).unwrap();
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err("无法检查应用数据目录，现有内容已保留".into())
        };
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err("应用数据位置必须是普通目录，不能是文件或符号链接".into());
    }
    Ok(Some((stat.st_dev as u64, stat.st_ino)))
}

fn instance_lock(directory: RawFd, attempts: usize) -> Result<File, String> {
    let name = CString::new("instance.lock").unwrap();
    let fd = unsafe {
        libc::openat(
            directory,
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("无法打开应用实例锁，请检查数据目录权限".into());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return Err("无法检查应用实例锁".into());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG || stat.st_nlink != 1 {
        return Err("应用实例锁必须是独立普通文件".into());
    }
    for attempt in 0..attempts.max(1) {
        if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        if attempt + 1 < attempts {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Err("CodexBoard 已在运行，请先正常退出旧应用后再打开；现有数据未迁移".into())
}

// Keep the same instance-lock inode across an atomic rename. The old updater
// starts us before it exits, so an update restart may wait for its lock release.
pub fn open(home: &Path, attempts: usize) -> Result<(PathBuf, File), String> {
    if !home.is_absolute() {
        return Err("用户目录必须是绝对路径".into());
    }
    let mut support = directory(libc::AT_FDCWD, OsStr::new("/"), false)?;
    for component in home.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => support = directory(support.as_raw_fd(), name, false)?,
            _ => return Err("用户目录不能包含上级跳转".into()),
        }
    }
    for name in ["Library", "Application Support"] {
        support = directory(support.as_raw_fd(), OsStr::new(name), true)?;
    }
    let parent = support.as_raw_fd();
    let existing = LEGACY_NAMES
        .iter()
        .chain(std::iter::once(&NAME))
        .map(|name| identity(parent, name).map(|id| (*name, id)))
        .collect::<Result<Vec<_>, _>>()?;
    let present: Vec<_> = existing.iter().filter(|(_, id)| id.is_some()).collect();
    if present.len() > 1 {
        return Err(
            "新旧应用数据目录同时存在。未合并或覆盖，请先核对目录后再打开 CodexBoard".into(),
        );
    }
    let selected = present.first().map(|(name, _)| *name).unwrap_or(NAME);
    let legacy = if selected != NAME {
        identity(parent, selected)?
    } else {
        None
    };
    let data = directory(parent, OsStr::new(selected), present.is_empty())?;
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(data.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err("无法检查已打开的数据目录".into());
    }
    let metadata = unsafe { metadata.assume_init() };
    let opened = (metadata.st_dev as u64, metadata.st_ino);
    if legacy.is_some_and(|expected| expected != opened) {
        return Err("旧版数据目录已变化，未迁移任何内容".into());
    }
    let lock = instance_lock(data.as_raw_fd(), attempts)?;
    if identity(parent, selected)? != Some(opened) {
        return Err("已锁定的数据目录发生变化，未继续启动".into());
    }
    if let Some(expected) = legacy {
        if identity(parent, selected)? != Some(expected)
            || existing.iter().any(|(name, _)| {
                *name != selected && identity(parent, name).map_or(true, |id| id.is_some())
            })
        {
            return Err("应用数据目录在迁移前发生变化，未覆盖任何目录，请重新检查".into());
        }
        let from = CString::new(selected).unwrap();
        let to = CString::new(NAME).unwrap();
        if unsafe {
            libc::renameatx_np(
                parent,
                from.as_ptr(),
                parent,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        } != 0
        {
            return Err("无法移动旧版数据目录，旧数据已保留；请检查目录权限或冲突后重试".into());
        }
    } else if LEGACY_NAMES
        .iter()
        .any(|name| identity(parent, name).map_or(true, |id| id.is_some()))
    {
        return Err("检测到旧版数据目录，未合并或覆盖，请核对新旧目录后重试".into());
    }
    Ok((path(home), lock))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "codexboard-data-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn legacy(&self) -> PathBuf {
            self.0
                .join("Library/Application Support")
                .join(LEGACY_NAMES[0])
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn new_install_creates_only_current_directory_and_holds_instance_lock() {
        let f = Fixture::new();
        let (data, lock) = open(&f.0, 1).unwrap();
        assert_eq!(data, path(&f.0));
        assert!(!f.legacy().exists());
        assert!(open(&f.0, 1).is_err());
        drop(lock);
        assert!(open(&f.0, 1).is_ok());
    }

    #[test]
    fn migration_preserves_database_wal_secrets_modes_and_directory_identity() {
        let f = Fixture::new();
        let old = f.legacy();
        fs::create_dir_all(old.join("data")).unwrap();
        fs::create_dir_all(old.join("secrets")).unwrap();
        for name in [
            "data/database.sqlite",
            "data/database.sqlite-wal",
            "secrets/frpc.toml",
        ] {
            fs::write(old.join(name), format!("synthetic {name}")).unwrap();
            fs::set_permissions(old.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let inode = fs::metadata(&old).unwrap().ino();
        let (new, _lock) = open(&f.0, 1).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::metadata(&new).unwrap().ino(), inode);
        for name in [
            "data/database.sqlite",
            "data/database.sqlite-wal",
            "secrets/frpc.toml",
        ] {
            assert_eq!(
                fs::read_to_string(new.join(name)).unwrap(),
                format!("synthetic {name}")
            );
            assert_eq!(fs::metadata(new.join(name)).unwrap().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn oldest_published_directory_migrates_directly_to_current_brand() {
        let f = Fixture::new();
        let old =
            f.0.join("Library/Application Support")
                .join(LEGACY_NAMES[1]);
        fs::create_dir_all(old.join("data")).unwrap();
        fs::write(old.join("data/keep"), "keep").unwrap();
        let (new, _lock) = open(&f.0, 1).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("data/keep")).unwrap(), "keep");
    }

    #[test]
    fn two_legacy_directories_are_not_merged() {
        let f = Fixture::new();
        for name in LEGACY_NAMES {
            fs::create_dir_all(f.0.join("Library/Application Support").join(name)).unwrap();
        }
        assert!(open(&f.0, 1).unwrap_err().contains("同时存在"));
        assert!(!path(&f.0).exists());
    }

    #[test]
    fn conflicting_directories_are_both_preserved() {
        let f = Fixture::new();
        fs::create_dir_all(f.legacy()).unwrap();
        fs::create_dir_all(path(&f.0)).unwrap();
        fs::write(f.legacy().join("old"), "old").unwrap();
        fs::write(path(&f.0).join("new"), "new").unwrap();
        assert!(open(&f.0, 1).unwrap_err().contains("同时存在"));
        assert_eq!(fs::read_to_string(f.legacy().join("old")).unwrap(), "old");
        assert_eq!(fs::read_to_string(path(&f.0).join("new")).unwrap(), "new");
    }

    #[test]
    fn a_running_old_instance_prevents_migration_until_it_releases_the_lock() {
        let f = Fixture::new();
        fs::create_dir_all(f.legacy()).unwrap();
        let old = directory(libc::AT_FDCWD, f.legacy().as_os_str(), false).unwrap();
        let held = instance_lock(old.as_raw_fd(), 1).unwrap();
        assert!(open(&f.0, 1).is_err());
        assert!(f.legacy().exists());
        assert!(!path(&f.0).exists());
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        let (_, _lock) = open(&f.0, 10).unwrap();
        release.join().unwrap();
        assert!(!f.legacy().exists());
    }

    #[test]
    fn symlinked_data_directory_or_parent_never_moves_the_link_target() {
        for old_link in [false, true] {
            let f = Fixture::new();
            let outside = f.0.join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("keep"), "keep").unwrap();
            let linked = if old_link {
                fs::create_dir_all(f.legacy().parent().unwrap()).unwrap();
                f.legacy()
            } else {
                f.0.join("Library")
            };
            symlink(&outside, linked).unwrap();
            assert!(open(&f.0, 1).is_err());
            assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "keep");
        }
    }

    #[test]
    fn linked_instance_lock_is_rejected_without_touching_its_target() {
        let f = Fixture::new();
        fs::create_dir_all(f.legacy()).unwrap();
        let outside = f.0.join("outside-lock");
        fs::write(&outside, "keep").unwrap();
        symlink(&outside, f.legacy().join("instance.lock")).unwrap();
        assert!(open(&f.0, 1).is_err());
        assert!(f.legacy().exists());
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
    }
}
