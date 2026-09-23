use std::{ffi::OsStr, io, path::Path, process::Command};

/// Start only a Node main script; native programs must use their own command.
pub(crate) fn command(program: impl AsRef<OsStr>, script: impl AsRef<Path>) -> io::Result<Command> {
    let mut command = Command::new(program);
    let script = script.as_ref();
    // Resolve Windows aliases to the on-disk spelling, including the extension.
    // Node's ESM classification treats .MJS differently from .mjs even on NTFS.
    #[cfg(windows)]
    let script = script.canonicalize()?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Node 22's main-path realpath step rejects the canonical \\?\ form
        // before loading JS.
        // Keep that verified path intact and bypass only the main-path step;
        // dependency resolution still uses Node's normal realpath behavior.
        command.arg("--preserve-symlinks-main");
    }
    command.arg(script);
    Ok(command)
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

    fn fixture() -> Fixture {
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
        fs::write(fixture.0.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(
            fixture.0.join("entry.mjs"),
            "import { stdout, argv } from 'node:process'; export const loaded = true; stdout.write('ENTRY_OK:' + argv[2]);",
        )
        .unwrap();
        fixture
    }

    #[test]
    fn node_main_options_precede_the_script_on_windows_only() {
        let fixture = fixture();
        let script = fixture.0.join("entry.mjs");
        let mut child = command("node", &script).unwrap();
        child.arg("argument");
        #[cfg(windows)]
        let script = script.canonicalize().unwrap();
        let expected: Vec<&OsStr> = if cfg!(windows) {
            vec![
                OsStr::new("--preserve-symlinks-main"),
                script.as_os_str(),
                OsStr::new("argument"),
            ]
        } else {
            vec![script.as_os_str(), OsStr::new("argument")]
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
        let fixture = fixture();
        let script = fixture.0.join("entry.mjs");
        #[allow(unused_mut)]
        let mut paths = vec![script.clone(), script.canonicalize().unwrap()];
        #[cfg(windows)]
        {
            assert!(paths[1].to_string_lossy().starts_with(r"\\?\"));
            paths.push(PathBuf::from(paths[1].to_string_lossy().to_uppercase()));
        }
        for path in paths {
            let output = command(&executable, &path)
                .unwrap()
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
