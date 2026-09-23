use crate::{skills_commit, Controller};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::Stdio,
    sync::{atomic::Ordering, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub struct Skills {
    operation: Mutex<()>,
}

struct MaintenanceLease<'a>(&'a Controller);
impl Drop for MaintenanceLease<'_> {
    fn drop(&mut self) {
        self.0.installing.store(false, Ordering::SeqCst);
    }
}

fn run(app: &tauri::AppHandle, action: &str, options: Value) -> Result<Value, String> {
    let skills = app.state::<Skills>();
    let _operation = skills
        .operation
        .lock()
        .map_err(|_| "Skill 管理器暂不可用")?;
    let controller = app.state::<Controller>();
    {
        // Use the same reservation as the app updater and quit. No live service
        // connection is needed: the bundled Node handles skill files directly.
        let _input = controller.input.lock().map_err(|_| "应用正在退出")?;
        if controller.quitting.load(Ordering::SeqCst)
            || controller.installing.swap(true, Ordering::SeqCst)
        {
            return Err("应用正在退出或安装更新，请完成后重试。".into());
        }
    }
    let _lease = MaintenanceLease(&controller);
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("无法定位当前用户目录")?);
    let app_data = crate::app_data::path(&home);
    let runtime = app
        .path()
        .resource_dir()
        .map_err(|_| "无法定位应用资源")?
        .join("runtime");
    let executable = tauri::process::current_binary(&app.env()).map_err(|_| "无法定位当前应用")?;
    let mut child = crate::quiet_command(crate::node_path(&runtime))
        .arg(runtime.join("desktop/skill-manager.mjs"))
        .arg(action)
        .arg(&runtime)
        .arg(&app_data)
        .arg(&home)
        .arg(executable)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "随包 Skill 管理工具不可用，请重新安装应用。")?;
    if let Some(mut input) = child.stdin.take() {
        if writeln!(input, "{options}").is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法联系 Skill 管理工具，请重试。".into());
        }
    }
    // Drain while Node runs: waiting for exit first can fill the stdout pipe.
    // A malformed tool response is bounded even if it keeps writing.
    let stdout = child.stdout.take().ok_or("无法读取 Skill 状态")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(30) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("Skill 操作未能及时完成，请刷新状态后检查结果。".into());
            }
        }
    };
    let output = reader
        .join()
        .map_err(|_| "无法读取 Skill 状态")?
        .map_err(|_| "无法读取 Skill 状态")?;
    if !status.success() || output.len() > 64 * 1024 {
        return Err("Skill 管理工具执行失败，请刷新状态并检查目录权限。".into());
    }
    let value: Value = serde_json::from_slice(&output).map_err(|_| "Skill 状态无效")?;
    if !value.is_object() || !value["status"].is_string() {
        return Err("Skill 状态无效".into());
    }
    Ok(value)
}

async fn execute(
    app: tauri::AppHandle,
    action: &'static str,
    options: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, action, options))
        .await
        .map_err(|_| "Skill 管理工具暂不可用")?
}

#[tauri::command]
pub async fn skill_status(app: tauri::AppHandle) -> Result<Value, String> {
    execute(app, "status", json!({})).await
}

#[tauri::command]
pub async fn install_skill(
    app: tauri::AppHandle,
    expected_fingerprint: Option<String>,
    replace_modified: Option<bool>,
) -> Result<Value, String> {
    if expected_fingerprint.as_ref().is_some_and(|value| {
        value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("Skill 状态已失效，请刷新后重试。".into());
    }
    execute(
        app,
        "install",
        json!({
            "expectedFingerprint": expected_fingerprint,
            "replaceModified": replace_modified.unwrap_or(false),
        }),
    )
    .await
}

#[tauri::command]
pub async fn dismiss_skill_offer(app: tauri::AppHandle) -> Result<Value, String> {
    execute(app, "dismiss", json!({})).await
}

// This private helper is entered before constructing Tauri. Node can request
// only a fixed canonical target and a sibling staging name, never a UI path.
pub fn handle_commit_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--codexboard-skill-commit") {
        return None;
    }
    let result = (|| {
        if args.len() != 6 {
            return Err("invalid arguments");
        }
        let home = PathBuf::from(crate::user_home().ok_or("missing user home")?);
        let expected = if args[4] == "-" && args[5] == "-" {
            None
        } else {
            Some((
                args[4].parse::<u64>().map_err(|_| "invalid device")?,
                args[5].parse::<u64>().map_err(|_| "invalid inode")?,
            ))
        };
        match args[2].as_str() {
            "install" => skills_commit::atomic_install(&home, &args[3], expected)
                .map_err(|_| "commit failed"),
            "rollback-new" => skills_commit::rollback_new_install(
                &home,
                &args[3],
                expected.ok_or("missing identity")?,
            )
            .map_err(|_| "rollback failed"),
            _ => Err("invalid operation"),
        }
    })();
    Some(if result.is_ok() { 0 } else { 1 })
}
