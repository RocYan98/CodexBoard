use std::{ffi::OsStr, process::Command};

/// Start only a Node main script; native programs must use their own command.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Tauri has already canonicalized the resource directory. Node 22's
        // main-path realpath step rejects its \\?\ form before loading JS.
        // Keep that verified path intact and bypass only the main-path step;
        // dependency resolution still uses Node's normal realpath behavior.
        command.arg("--preserve-symlinks-main");
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::SystemTime};

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn node_main_options_precede_the_script_on_windows_only() {
        let mut child = command("node");
        child.arg("entry.mjs").arg("argument");
        let expected: Vec<&OsStr> = if cfg!(windows) {
            vec![
                OsStr::new("--preserve-symlinks-main"),
                OsStr::new("entry.mjs"),
                OsStr::new("argument"),
            ]
        } else {
            vec![OsStr::new("entry.mjs"), OsStr::new("argument")]
        };
        assert_eq!(child.get_args().collect::<Vec<_>>(), expected);
    }

    #[test]
    fn actual_node_loads_canonical_resources_with_spaces_and_unicode() {
        let installed_node = Command::new("node")
            .args(["-p", "process.execPath"])
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .output()
            .expect("Node must be installed to test the native launch boundary");
        assert!(installed_node.status.success());
        let executable = PathBuf::from(String::from_utf8(installed_node.stdout).unwrap().trim())
            .canonicalize()
            .unwrap();
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "codexboard-node-{}-{unique} 安装资源 with spaces",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let script = fixture.0.join("entry.mjs");
        fs::write(
            &script,
            "process.stdout.write('ENTRY_OK:' + process.argv[2]);",
        )
        .unwrap();
        #[allow(unused_mut)]
        let mut paths = vec![script.clone(), script.canonicalize().unwrap()];
        #[cfg(windows)]
        {
            assert!(paths[1].to_string_lossy().starts_with(r"\\?\"));
            paths.push(PathBuf::from(paths[1].to_string_lossy().to_uppercase()));
        }
        for path in paths {
            let output = command(&executable)
                .arg(&path)
                .arg("参数 with spaces")
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "entry {path:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.stdout, "ENTRY_OK:参数 with spaces".as_bytes());
            assert!(output.stderr.is_empty());
        }
    }
}
