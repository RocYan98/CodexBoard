use crate::windows_paths;
use std::{
    fs::{self, File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

pub fn path(home: &Path) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"))
        .join("CodexBoard")
}
fn protect_directory(data: &Path) -> Result<(), String> {
    // Only a path is passed through the environment; all PowerShell source is fixed.
    let status = crate::quiet_command("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; $p=$env:CODEXBOARD_PROTECT_DIRECTORY; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl"])
        .env("CODEXBOARD_PROTECT_DIRECTORY", data).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|_| "无法设置应用目录权限")?;
    if !status.success() {
        return Err("无法保护应用目录，未启动服务".into());
    }
    Ok(())
}
pub fn open(home: &Path, attempts: usize) -> Result<(PathBuf, File), String> {
    open_at(&path(home), attempts)
}
fn open_at(data: &Path, attempts: usize) -> Result<(PathBuf, File), String> {
    let parent = data.parent().ok_or("应用目录无效")?;
    let _parents = windows_paths::directories(parent)?;
    match fs::create_dir(data) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("无法创建应用数据目录".into()),
    }
    let _data = windows_paths::directories(data)?;
    protect_directory(data)?;
    for attempt in 0..attempts.max(1) {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .custom_flags(0x00200000)
            .open(data.join("instance.lock"))
        {
            Ok(lock) => {
                if !lock.metadata().map_err(|_| "无法检查实例锁")?.is_file()
                    || windows_paths::metadata(&lock)?.1 != 1
                {
                    return Err("实例锁必须是独立普通文件".into());
                }
                return Ok((data.to_path_buf(), lock));
            }
            Err(_) if attempt + 1 < attempts => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return Err("CodexBoard 已在运行或实例锁不可访问，请先正常退出旧应用".into()),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_one_instance_holds_the_existing_lock_and_data_survives() {
        let root = std::env::temp_dir().join(format!(
            "codexboard-win-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let directory = root.join("CodexBoard");
        let (_, lock) = open_at(&directory, 1).unwrap();
        fs::write(directory.join("keep"), "existing data").unwrap();
        assert!(open_at(&directory, 1).is_err());
        drop(lock);
        let (_, lock) = open_at(&directory, 1).unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("keep")).unwrap(),
            "existing data"
        );
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
}
