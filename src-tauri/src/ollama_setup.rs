use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use tauri::Emitter;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;

#[cfg(target_os = "linux")]
const RELEASE: &str = "v0.40.14";
const MAX_INSTALLER_BYTES: u64 = 2_000_000_000;

#[tauri::command]
pub(crate) async fn install_ollama(app: tauri::AppHandle) -> Result<(), String> {
    let worker_app = app.clone();
    match tokio::task::spawn_blocking(move || install_ollama_inner(&worker_app)).await {
        Ok(result) => result,
        Err(_) => Err("Установщик Ollama был прерван.".into()),
    }
}

fn install_ollama_inner(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return install_windows(app);
    }
    #[cfg(target_os = "macos")]
    {
        return install_macos(app);
    }
    #[cfg(target_os = "linux")]
    {
        return install_linux(app);
    }
    #[allow(unreachable_code)]
    Err("Автоматическая установка Ollama не поддерживается в этой системе.".into())
}

fn emit_install_progress(app: &tauri::AppHandle, message: impl Into<String>) {
    let _ = app.emit(
        "ollama-install-progress",
        serde_json::json!({ "message": message.into() }),
    );
}

fn emit_download_progress(app: &tauri::AppHandle, downloaded: u64, total: u64) {
    let message = if total > 0 {
        format!(
            "Скачан установщик Ollama: {} из {} МБ",
            downloaded / 1_000_000,
            total / 1_000_000
        )
    } else {
        format!("Скачан установщик Ollama: {} МБ", downloaded / 1_000_000)
    };
    let _ = app.emit(
        "ollama-install-progress",
        serde_json::json!({
            "message": message,
            "completed": downloaded,
            "total": total,
        }),
    );
}

fn download_verified_asset(
    app: &tauri::AppHandle,
    url: &str,
    expected_sha256: &str,
    filename: &str,
) -> Result<PathBuf, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(3 * 60 * 60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("Norman Ollama installer")
        .build()
        .map_err(|_| "Не удалось подготовить защищённое подключение к Ollama.".to_string())?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|_| "Не удалось скачать официальный установщик Ollama.".to_string())?
        .error_for_status()
        .map_err(|_| "Сервер не отдал официальный установщик Ollama.".to_string())?;
    let total = response.content_length().unwrap_or_default();
    if total > MAX_INSTALLER_BYTES {
        return Err("Размер установщика Ollama превышает допустимый лимит.".into());
    }

    let temp_dir = env::temp_dir().join("norman-ollama-install");
    fs::create_dir_all(&temp_dir)
        .map_err(|_| "Не удалось подготовить временную папку для установщика Ollama.".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = temp_dir.join(format!("{}-{}-{nonce}", std::process::id(), filename));
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(_) => return Err("Не удалось сохранить установщик Ollama.".into()),
    };
    let result = (|| {
        let mut hasher = Sha256::new();
        let mut downloaded = 0_u64;
        let mut last_reported = 0_u64;
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(|_| "Загрузка установщика Ollama прервалась.".to_string())?;
            if read == 0 {
                break;
            }
            downloaded = downloaded.saturating_add(read as u64);
            if downloaded > MAX_INSTALLER_BYTES {
                return Err("Размер установщика Ollama превышает допустимый лимит.".into());
            }
            file.write_all(&buffer[..read])
                .map_err(|_| "Не удалось записать установщик Ollama на диск.".to_string())?;
            hasher.update(&buffer[..read]);
            if downloaded - last_reported >= 16 * 1024 * 1024 {
                emit_download_progress(app, downloaded, total);
                last_reported = downloaded;
            }
        }
        file.flush()
            .map_err(|_| "Не удалось завершить сохранение установщика Ollama.".to_string())?;
        let actual_sha256 = format!("{:x}", hasher.finalize());
        if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
            return Err("Контрольная сумма установщика Ollama не совпала; файл не будет запущен.".into());
        }
        Ok(path.clone())
    })();

    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(&path);
    }
    result
}

fn user_home() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Не удалось определить папку текущего пользователя.".into())
}

fn start_existing_cli() -> bool {
    Command::new("ollama")
        .arg("serve")
        .env("OLLAMA_HOST", "127.0.0.1:11434")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(target_os = "windows")]
fn install_windows(app: &tauri::AppHandle) -> Result<(), String> {
    if start_existing_cli() {
        return Ok(());
    }
    #[cfg(target_arch = "x86_64")]
    {
        const URL: &str = "https://github.com/ollama/ollama/releases/download/v0.40.14/OllamaSetup.exe";
        const SHA256: &str = "e069c7cc7d4808f77684e81efa0b1f853a5190b4b8f070bc8fd63041180e3eba";
        emit_install_progress(app, "Скачиваем официальный установщик Ollama для Windows…");
        let installer = download_verified_asset(app, URL, SHA256, "OllamaSetup.exe")?;
        emit_install_progress(app, "Проверяем и запускаем установщик Ollama…");
        let result = Command::new(&installer)
            .args(["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "Не удалось запустить установщик Ollama для Windows.".to_string())
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("Установщик Ollama для Windows завершился с ошибкой.".into())
                }
            });
        let _ = fs::remove_file(installer);
        return result;
    }
    #[cfg(not(target_arch = "x86_64"))]
    Err("Автоматическая установка Ollama поддерживается только в Windows x64.".into())
}

#[cfg(target_os = "macos")]
fn install_macos(app: &tauri::AppHandle) -> Result<(), String> {
    let open_existing = Command::new("open")
        .args(["-a", "Ollama"])
        .status()
        .is_ok_and(|status| status.success());
    if open_existing || start_existing_cli() {
        return Ok(());
    }

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        const URL: &str = "https://github.com/ollama/ollama/releases/download/v0.40.14/Ollama-darwin.zip";
        const SHA256: &str = "9047386fb6811f54fc98b12ce4fea42a6ee5ce9e1bbc0c8196499f347054bcb5";
        emit_install_progress(app, "Скачиваем официальный Ollama для macOS…");
        let archive = download_verified_asset(app, URL, SHA256, "Ollama-darwin.zip")?;
        emit_install_progress(app, "Проверяем архив и устанавливаем Ollama…");
        let work_dir = archive.with_extension("unpacked");
        let result = (|| {
            let status = Command::new("ditto")
                .args(["-x", "-k"])
                .arg(&archive)
                .arg(&work_dir)
                .status()
                .map_err(|_| "Не удалось распаковать Ollama для macOS.".to_string())?;
            if !status.success() {
                return Err("Архив Ollama для macOS не удалось распаковать.".into());
            }
            let source = find_ollama_app(&work_dir)
                .ok_or_else(|| "В архиве не найдено приложение Ollama.".to_string())?;
            let destination = user_home()?.join("Applications").join("Ollama.app");
            fs::create_dir_all(destination.parent().unwrap())
                .map_err(|_| "Не удалось создать папку приложений пользователя.".to_string())?;
            if destination.exists() {
                return Err("В ~/Applications уже есть Ollama.app; удалите или переместите его и повторите установку.".into());
            }
            let status = Command::new("ditto")
                .arg(&source)
                .arg(&destination)
                .status()
                .map_err(|_| "Не удалось установить Ollama в папку пользователя.".to_string())?;
            if !status.success() {
                return Err("Не удалось установить Ollama в папку пользователя.".into());
            }
            Command::new("open")
                .arg("-a")
                .arg(&destination)
                .spawn()
                .map_err(|_| "Ollama установлена, но не удалось запустить приложение.".to_string())?;
            Ok(())
        })();
        let _ = fs::remove_file(archive);
        let _ = fs::remove_dir_all(work_dir);
        return result;
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    Err("Автоматическая установка Ollama не поддерживается для этой архитектуры macOS.".into())
}

#[cfg(target_os = "macos")]
fn find_ollama_app(root: &Path) -> Option<PathBuf> {
    let direct = root.join("Ollama.app");
    if direct.is_dir() {
        return Some(direct);
    }
    let nested = root.join("Applications").join("Ollama.app");
    nested.is_dir().then_some(nested)
}

#[cfg(target_os = "linux")]
fn install_linux(app: &tauri::AppHandle) -> Result<(), String> {
    let install_dir = user_home()?.join(".local/share/norman/ollama");
    let existing_binary = install_dir.join("ollama");
    if start_cli_at(&existing_binary) || start_existing_cli() {
        return Ok(());
    }
    #[cfg(target_arch = "x86_64")]
    {
        return install_linux_asset(
            app,
            &install_dir,
            "ollama-linux-amd64.tar.zst",
            "993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d",
        );
    }
    #[cfg(target_arch = "aarch64")]
    {
        return install_linux_asset(
            app,
            &install_dir,
            "ollama-linux-arm64.tar.zst",
            "39bb333b7b4c0bafcdd7fad35eab1ae9aaf4518ea0f2c731de4376e3a29c94d0",
        );
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        Err("Автоматическая установка Ollama поддерживается только в Linux x64 и ARM64.".into())
    }
}

#[cfg(target_os = "linux")]
fn install_linux_asset(
    app: &tauri::AppHandle,
    install_dir: &Path,
    asset: &str,
    hash: &str,
) -> Result<(), String> {
    emit_install_progress(app, "Скачиваем официальный Ollama для Linux…");
    let url = format!("https://github.com/ollama/ollama/releases/download/{RELEASE}/{asset}");
    let archive = download_verified_asset(app, &url, hash, asset)?;
    emit_install_progress(app, "Проверяем архив и устанавливаем Ollama в папку пользователя…");
    let staging_dir = install_dir.with_extension("installing");
    let result = (|| {
        if staging_dir.exists() {
            fs::remove_dir_all(&staging_dir)
                .map_err(|_| "Не удалось очистить временную папку установки Ollama.".to_string())?;
        }
        fs::create_dir_all(&staging_dir)
            .map_err(|_| "Не удалось создать папку Ollama в профиле пользователя.".to_string())?;
        let status = Command::new("tar")
            .args(["--zstd", "-xf"])
            .arg(&archive)
            .args(["-C"])
            .arg(&staging_dir)
            .status()
            .map_err(|_| "Для распаковки Ollama в Linux требуются tar и zstd.".to_string())?;
        if !status.success() {
            return Err("Не удалось распаковать Ollama. Проверьте, что в Linux установлена утилита zstd.".into());
        }
        let binary = staging_dir.join("ollama");
        if !binary.is_file() {
            return Err("В архиве Ollama не найден исполняемый файл.".into());
        }
        if install_dir.exists() {
            fs::remove_dir_all(install_dir)
                .map_err(|_| "Не удалось заменить пользовательскую установку Ollama.".to_string())?;
        }
        fs::rename(&staging_dir, install_dir)
            .map_err(|_| "Не удалось завершить установку Ollama в папку пользователя.".to_string())?;
        if !start_cli_at(&install_dir.join("ollama")) {
            return Err("Ollama установлена, но не удалось запустить локальный сервер.".into());
        }
        Ok(())
    })();
    let _ = fs::remove_file(archive);
    let _ = fs::remove_dir_all(staging_dir);
    result
}

#[cfg(target_os = "linux")]
fn start_cli_at(binary: &Path) -> bool {
    if !binary.is_file() {
        return false;
    }
    Command::new(binary)
        .arg("serve")
        .env("OLLAMA_HOST", "127.0.0.1:11434")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}
