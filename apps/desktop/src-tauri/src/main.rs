#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(target_os = "macos")]
mod app_data;
#[cfg(target_os = "windows")]
#[path = "app_data_windows.rs"]
mod app_data;
mod node_command;
mod skills;
#[cfg(target_os = "macos")]
mod skills_commit;
#[cfg(target_os = "windows")]
#[path = "skills_commit_windows.rs"]
mod skills_commit;
mod tray_icon;
#[cfg(target_os = "macos")]
mod updater;
#[cfg(target_os = "windows")]
#[path = "updater_windows.rs"]
mod updater;
#[cfg(target_os = "windows")]
mod windows_paths;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
struct Controller {
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    snapshot: Arc<Mutex<Value>>,
    quitting: AtomicBool,
    installing: AtomicBool,
    update_stop_ack: Arc<Mutex<Option<(u64, bool)>>>,
    _lock: File,
}
#[tauri::command]
fn snapshot(state: tauri::State<Controller>) -> Value {
    state.snapshot.lock().unwrap().clone()
}
#[tauri::command]
fn control(
    action: String,
    settings: Option<Value>,
    state: tauri::State<Controller>,
) -> Result<(), String> {
    if ![
        "start",
        "stop",
        "restart",
        "open_board",
        "deployment",
        "ports",
        "setup_check",
        "web_accounts",
        "open_web_board",
        "setup_open",
    ]
    .contains(&action.as_str())
    {
        return Err("无效操作".into());
    }
    let request = json!({"id":1,"action":action,"settings":settings});
    let mut input = state.input.lock().unwrap();
    if state.quitting.load(Ordering::SeqCst) || state.installing.load(Ordering::SeqCst) {
        return Err("应用正在退出或安装更新".into());
    }
    let stdin = input.as_mut().ok_or("服务管理器已退出")?;
    writeln!(stdin, "{}", request).map_err(|_| "无法联系服务管理器".to_string())
}
#[tauri::command]
fn open_board(state: tauri::State<Controller>) -> Result<(), String> {
    control("open_board".into(), None, state)
}
#[tauri::command]
fn open_release_page() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("/usr/bin/open")
        .arg("https://github.com/RocYan98/CodexBoard/releases/latest")
        .status();
    #[cfg(target_os = "windows")]
    let status = quiet_command("rundll32.exe")
        .args([
            "url.dll,FileProtocolHandler",
            "https://github.com/RocYan98/CodexBoard/releases/latest",
        ])
        .status();
    let status = status.map_err(|_| "无法打开默认浏览器".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("无法打开默认浏览器".into())
    }
}
fn node_path(root: &std::path::Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "bin/node.exe"
    } else {
        "bin/node"
    })
}
fn user_home() -> Option<std::ffi::OsString> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
}
#[cfg(windows)]
fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}
fn quit(app: tauri::AppHandle) {
    let state = app.state::<Controller>();
    let mut input = state.input.lock().unwrap();
    if state.installing.load(Ordering::SeqCst) {
        return;
    }
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    // Closing stdin tells the controller to drain only its owned process groups.
    input.take();
    drop(input);
    std::thread::spawn(move || {
        let state = app.state::<Controller>();
        let mut child = state.child.lock().unwrap();
        for _ in 0..300 {
            if child.try_wait().ok().flatten().is_some() {
                app.exit(0);
                return;
            }
            std::thread::sleep(Duration::from_millis(100))
        }
        let _ = child.kill();
        let _ = child.wait();
        app.exit(1);
    });
}
impl Controller {
    fn stop_for_update(&self) -> Result<(), String> {
        static NEXT_REQUEST: AtomicU64 = AtomicU64::new(2);
        let request_id = NEXT_REQUEST.fetch_add(1, Ordering::SeqCst);
        if let Some(status) = self
            .child
            .lock()
            .unwrap()
            .try_wait()
            .map_err(|_| "无法检查服务管理器状态")?
        {
            return if status.success() {
                Ok(())
            } else {
                Err("服务管理器退出异常，请重新打开应用后再安装更新。".into())
            };
        }
        *self.update_stop_ack.lock().unwrap() = None;
        {
            let mut input = self.input.lock().unwrap();
            let stdin = input.as_mut().ok_or("服务管理器正在退出，请稍后重试")?;
            writeln!(stdin, "{}", json!({"id":request_id,"action":"stop"}))
                .map_err(|_| "无法停止后台服务，未安装更新")?;
        }
        for _ in 0..300 {
            if let Some((id, ok)) = *self.update_stop_ack.lock().unwrap() {
                if id == request_id {
                    return if ok {
                        Ok(())
                    } else {
                        Err("后台服务未能停止，未安装更新".into())
                    };
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("停止后台服务超时，未安装更新。请等待服务停止后重试。".into())
    }

    fn drain_for_update(&self) -> Result<(), String> {
        // EOF drains only this controller's children; never signal Codex Desktop.
        self.input.lock().unwrap().take();
        for _ in 0..300 {
            if let Some(status) = self
                .child
                .lock()
                .unwrap()
                .try_wait()
                .map_err(|_| "无法确认服务管理器已退出")?
            {
                return if status.success() {
                    Ok(())
                } else {
                    Err("服务管理器退出异常，更新已安装，请手动重新打开应用。".into())
                };
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("服务管理器尚未退出，更新已安装。请稍后重试或手动重新打开应用。".into())
    }
}
fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show-main", "显示主窗口", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "check-updates", "检查更新…", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "quit-app", "退出 CodexBoard", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &update, &exit])?;
    let tray = TrayIconBuilder::with_id("codexboard")
        .tooltip("CodexBoard")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show-main" => show_main_window(app),
            "check-updates" => {
                show_main_window(app);
                let _ = updater::check_updates(app.clone(), Some(false), None);
            }
            "quit-app" => quit(app.clone()),
            _ => {}
        });
    #[cfg(target_os = "windows")]
    let tray = tray.icon(
        app.default_window_icon()
            .expect("bundled application icon")
            .clone(),
    );
    let tray = tray.build(app)?;
    tray_icon::install(&tray)?;
    Ok(())
}
fn main() {
    if let Some(code) = skills::handle_commit_cli() {
        std::process::exit(code);
    }
    let attempts = if std::env::args()
        .any(|arg| ["--codexboard-updated", "--lark-codex-updated"].contains(&arg.as_str()))
    {
        300
    } else {
        1
    };
    let prepared = user_home()
        .ok_or_else(|| "无法定位当前用户目录".to_string())
        .and_then(|home| app_data::open(&PathBuf::from(home), attempts));
    let (data, lock) = prepared.unwrap_or_else(|message| {
        #[cfg(target_os = "macos")]
        let _ = Command::new("/usr/bin/osascript")
            .args(["-e", "on run argv\n display alert \"无法启动 CodexBoard\" message (item 1 of argv) as critical\nend run", &message])
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
        #[cfg(target_os = "windows")]
        windows_paths::show_error(&message);
        std::process::exit(1);
    });
    let app=tauri::Builder::default().plugin(tauri_plugin_updater::Builder::new().build()).setup(move |app|{
  app.manage(updater::Updates::new(app.package_info().version.to_string(), &data));
  app.manage(skills::Skills::default());
  setup_tray(app)?;
  let root=app.path().resource_dir()?.join("runtime");
  let mut child=node_command::command(node_path(&root)).arg(root.join("desktop/runtime.mjs")).arg(&root).arg(&data).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
  let input=child.stdin.take();let output=child.stdout.take().unwrap();let snapshot=Arc::new(Mutex::new(json!({"phase":"starting","message":"正在启动服务管理器…","services":[],"logs":[],"settings":{}})));let copy=snapshot.clone();
  let update_stop_ack=Arc::new(Mutex::new(None));let ack=update_stop_ack.clone();
  std::thread::spawn(move||{for line in BufReader::new(output).lines().map_while(Result::ok){if let Ok(value)=serde_json::from_str::<Value>(&line){if let (Some(id),Some(ok))=(value["id"].as_u64(),value["ok"].as_bool()) { if id>=2 { *ack.lock().unwrap()=Some((id,ok)); } } if value["event"]=="state"{*copy.lock().unwrap()=value["data"].clone()}else if value["ok"]==false{copy.lock().unwrap()["message"]=value["error"].clone()}}}let mut s=copy.lock().unwrap();s["phase"]=json!("error");s["message"]=json!("服务管理器已退出，请重新打开应用");});
  app.manage(Controller{child:Mutex::new(child),input:Mutex::new(input),snapshot,quitting:AtomicBool::new(false),installing:AtomicBool::new(false),update_stop_ack,_lock:lock});Ok(())
 }).invoke_handler(tauri::generate_handler![snapshot,control,open_board,open_release_page,updater::update_status,updater::check_updates,updater::download_update,updater::install_update,skills::skill_status,skills::install_skill,skills::dismiss_skill_offer]).on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _ = window.hide();
    #[cfg(target_os = "macos")]
    let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);}}).build(tauri::generate_context!()).expect("无法启动 CodexBoard");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            show_main_window(app);
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Controller>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                quit(app.clone())
            }
        }
    });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    struct Fixture(Controller);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let child = self.0.child.get_mut().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn fixture(mut child: Child) -> Fixture {
        let input = child.stdin.take();
        Fixture(Controller {
            child: Mutex::new(child),
            input: Mutex::new(input),
            snapshot: Arc::new(Mutex::new(json!({}))),
            quitting: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            update_stop_ack: Arc::new(Mutex::new(None)),
            _lock: File::open("/dev/null").unwrap(),
        })
    }

    #[test]
    fn update_waits_for_its_own_stop_ack_and_keeps_controller_until_install_finishes() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let fixture = fixture(child);
        let ack = fixture.0.update_stop_ack.clone();
        let listener = std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(output).read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["action"], "stop");
            let id = request["id"].as_u64().unwrap();
            *ack.lock().unwrap() = Some((id + 1, true));
            std::thread::sleep(Duration::from_millis(150));
            *ack.lock().unwrap() = Some((id, true));
        });
        let started = std::time::Instant::now();
        fixture.0.stop_for_update().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(fixture.0.input.lock().unwrap().is_some());
        assert!(fixture
            .0
            .child
            .lock()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        listener.join().unwrap();
        fixture.0.drain_for_update().unwrap();
        assert!(fixture
            .0
            .child
            .lock()
            .unwrap()
            .try_wait()
            .unwrap()
            .unwrap()
            .success());
    }

    #[test]
    fn an_abnormal_controller_exit_does_not_allow_automatic_restart() {
        let child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let fixture = fixture(child);
        assert!(fixture.0.drain_for_update().is_err());
        assert!(!fixture.0.quitting.load(Ordering::SeqCst));
    }
}
