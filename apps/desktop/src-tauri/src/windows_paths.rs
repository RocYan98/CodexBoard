use std::{
    ffi::{c_void, OsStr},
    fs::{File, OpenOptions},
    mem::MaybeUninit,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf},
};

const REPARSE_POINT: u32 = 0x400;
#[repr(C)]
struct FileInformation {
    attributes: u32,
    creation: [u32; 2],
    access: [u32; 2],
    write: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(file: *mut c_void, information: *mut FileInformation) -> i32;
    fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(window: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
pub fn show_error(message: &str) {
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(OsStr::new(message)).as_ptr(),
            wide(OsStr::new("无法启动 CodexBoard")).as_ptr(),
            0x10,
        );
    }
}
pub fn metadata(file: &File) -> Result<((u64, u64), u32), String> {
    let mut info = MaybeUninit::<FileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("无法检查文件身份".into());
    }
    let info = unsafe { info.assume_init() };
    if info.attributes & REPARSE_POINT != 0 {
        return Err("路径不能包含重解析点".into());
    }
    Ok((
        (
            info.volume as u64,
            ((info.index_high as u64) << 32) | info.index_low as u64,
        ),
        info.links,
    ))
}
// Retained handles deny parent deletion/rename while a path-based operation runs.
pub fn directories(path: &Path) -> Result<Vec<File>, String> {
    if !path.is_absolute() {
        return Err("路径必须是绝对路径".into());
    }
    let mut current = PathBuf::new();
    let mut handles = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component),
            Component::Normal(name) => {
                current.push(name);
                let file = OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .custom_flags(0x02000000 | 0x00200000)
                    .open(&current)
                    .map_err(|_| "无法打开目录，请检查路径和权限")?;
                if !file.metadata().map_err(|_| "无法检查目录")?.is_dir() {
                    return Err("路径必须是目录".into());
                }
                metadata(&file)?;
                handles.push(file);
            }
            _ => return Err("路径不能包含上级跳转".into()),
        }
    }
    Ok(handles)
}
pub fn identity(path: &Path) -> Result<Option<(u64, u64)>, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法检查目录身份".into()),
        Ok(meta) => {
            if !meta.is_dir() || meta.file_attributes() & REPARSE_POINT != 0 {
                return Err("位置必须是普通目录".into());
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(7)
                .custom_flags(0x02000000 | 0x00200000)
                .open(path)
                .map_err(|_| "无法打开目录")?;
            Ok(Some(metadata(&file)?.0))
        }
    }
}
pub fn rename_new(from: &Path, to: &Path) -> Result<(), String> {
    // MoveFileW never overwrites an existing destination, including empty directories.
    if unsafe {
        MoveFileW(
            wide(from.as_os_str()).as_ptr(),
            wide(to.as_os_str()).as_ptr(),
        )
    } == 0
    {
        return Err("目录提交失败，现有内容已保留".into());
    }
    Ok(())
}
