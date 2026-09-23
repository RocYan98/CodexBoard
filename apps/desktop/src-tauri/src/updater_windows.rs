// The Windows test installer does not share the macOS tar replacement protocol.
// Keep updates explicit until a signed Windows updater channel is published.
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

const MESSAGE: &str = "Windows 测试版请下载新的 Windows 安装包升级；当前不支持应用内自动更新。";
pub struct Updates {
    version: String,
}
impl Updates {
    pub fn new(version: String, _data: &Path) -> Self {
        Self { version }
    }
    fn status(&self) -> Value {
        json!({"currentVersion": self.version, "status": "error", "version": null,
            "notes": null, "downloadedBytes": 0, "totalBytes": null,
            "error": MESSAGE, "lastChecked": null, "canInstall": false})
    }
}
#[tauri::command]
pub fn update_status(app: tauri::AppHandle) -> Value {
    app.state::<Updates>().status()
}
#[tauri::command]
pub fn check_updates(
    app: tauri::AppHandle,
    automatic: Option<bool>,
    proxy: Option<String>,
) -> Result<Value, String> {
    let _ = (automatic, proxy);
    Ok(update_status(app))
}
#[tauri::command]
pub fn download_update(_app: tauri::AppHandle, proxy: Option<String>) -> Result<Value, String> {
    let _ = proxy;
    Err(MESSAGE.into())
}
#[tauri::command]
pub fn install_update(_app: tauri::AppHandle) -> Result<Value, String> {
    Err(MESSAGE.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_test_build_never_offers_the_macos_updater() {
        let state = Updates::new("0.1.10".into(), Path::new("C:\\unused"));
        assert_eq!(state.status()["canInstall"], false);
        assert_eq!(state.status()["status"], "error");
        assert!(state.status()["error"]
            .as_str()
            .unwrap()
            .contains("Windows"));
    }
}
