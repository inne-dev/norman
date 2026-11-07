use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use tauri::Emitter;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;

const LATEST_OLLAMA_RELEASE_API: &str =
    "https://api.github.com/repos/ollama/ollama/releases/latest";
const MAX_INSTALLER_BYTES: u64 = 2_000_000_000;
const CANCELLED_MESSAGE: &str = "Установка Ollama отменена.";

static OLLAMA_SETUP_CANCELLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub(crate) fn begin_ollama_setup() {
    OLLAMA_SETUP_CANCELLED.store(false, Ordering::Release);
}

#[tauri::command]
pub(crate) fn cancel_ollama_setup() {
    OLLAMA_SETUP_CANCELLED.store(true, Ordering::Release);
}

pub(crate) fn is_ollama_setup_cancelled() -> bool {
    OLLAMA_SETUP_CANCELLED.load(Ordering::Acquire)
}

pub(crate) fn check_setup_cancelled() -> Result<(), String> {
    if is_ollama_setup_cancelled() {
        Err(CANCELLED_MESSAGE.into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn install_ollama(app: tauri::AppHandle) -> Result<(), String> {
    let worker_app = app.clone();
    match tokio::task::spawn_blocking(move || install_ollama_inner(&worker_app)).await {
        Ok(result) => result,
        Err(_) => Err("Установщик Ollama был прерван.".into()),
    }
}

#[tauri::command]
pub(crate) async fn start_ollama() -> Result<(), String> {
    tokio::task::spawn_blocking(start_ollama_inner)
        .await
        .map_err(|_| "Не удалось запустить Ollama.".to_string())?
}

pub(crate) fn is_ollama_installed() -> bool {
    ollama_cli_path().is_some() || ollama_app_path().is_some()
}

fn ollama_cli_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let installed_cli = PathBuf::from(local_app_data)
            .join("Programs")
            .join("Ollama")
            .join("ollama.exe");
        if installed_cli.is_file() {
            return Some(installed_cli);
        }
    }

    #[cfg(target_os = "linux")]
    if let Ok(home) = user_home() {
        let bundled_cli = home
            .join(".local")
            .join("share")
            .join("norman")
            .join("ollama")
            .join("ollama");
        if bundled_cli.is_file() {
            return Some(bundled_cli);
        }
    }

    #[cfg(target_os = "linux")]
    for path in ["/usr/local/bin/ollama", "/usr/bin/ollama"] {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    #[cfg(target_os = "macos")]
    for path in ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"] {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|directory| {
        #[cfg(target_os = "windows")]
        let candidate = directory.join("ollama.exe");
        #[cfg(not(target_os = "windows"))]
        let candidate = directory.join("ollama");
        candidate.is_file().then_some(candidate)
    })
}

fn ollama_app_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = PathBuf::from(env::var_os("LOCALAPPDATA")?);
        let app = local_app_data
            .join("Programs")
            .join("Ollama")
            .join("ollama app.exe");
        app.is_file().then_some(app)
    }
    #[cfg(target_os = "macos")]
    {
        let user_app = user_home().ok()?.join("Applications").join("Ollama.app");
        let system_app = PathBuf::from("/Applications/Ollama.app");
        [user_app, system_app].into_iter().find(|app| app.is_dir())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

fn start_ollama_inner() -> Result<(), String> {
    if !is_ollama_installed() {
        return Err("Установленная Ollama не найдена. Проверьте путь или установите её заново.".into());
    }
    if is_ollama_server_listening() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    if let Some(app) = ollama_app_path() {
        return Command::new(app)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| "Не удалось запустить установленную Ollama.".into());
    }

    #[cfg(target_os = "macos")]
    if let Some(app) = ollama_app_path() {
        return Command::new("open")
            .arg("-a")
            .arg(app)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| "Не удалось запустить установленную Ollama.".into());
    }

    if let Some(cli) = ollama_cli_path() {
        return Command::new(cli)
            .arg("serve")
            .env("OLLAMA_HOST", "127.0.0.1:11434")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| "Не удалось запустить установленную Ollama.".into());
    }

    Err("Установленная Ollama не найдена. Проверьте путь или установите её заново.".into())
}

fn is_ollama_server_listening() -> bool {
    use std::net::{SocketAddr, TcpStream};

    let address = SocketAddr::from(([127, 0, 0, 1], 11434));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
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

struct VerifiedReleaseAsset {
    version: String,
    url: String,
    sha256: String,
}

fn latest_ollama_release_asset(asset_name: &str) -> Result<VerifiedReleaseAsset, String> {
    check_setup_cancelled()?;
    if asset_name.is_empty()
        || !asset_name
            .bytes()
            .all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
            })
    {
        return Err("Имя файла Ollama в релизе некорректно.".into());
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent("Norman Ollama installer")
        .build()
        .map_err(|_| "Не удалось подготовить подключение к GitHub.".to_string())?;
    let response = client
        .get(LATEST_OLLAMA_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .map_err(|_| "Не удалось получить последнюю стабильную версию Ollama.".to_string())?
        .error_for_status()
        .map_err(|_| "GitHub не вернул последнюю стабильную версию Ollama.".to_string())?;
    let mut payload = String::new();
    response
        .take(1_000_001)
        .read_to_string(&mut payload)
        .map_err(|_| "Не удалось прочитать информацию о последней версии Ollama.".to_string())?;
    check_setup_cancelled()?;
    if payload.len() > 1_000_000 {
        return Err("Ответ GitHub о версии Ollama превышает допустимый размер.".into());
    }

    let release: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|_| "GitHub вернул некорректную информацию о версии Ollama.".to_string())?;
    if release.get("draft").and_then(serde_json::Value::as_bool) != Some(false)
        || release
            .get("prerelease")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return Err("GitHub не вернул стабильный релиз Ollama.".into());
    }
    let version = release
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .filter(|tag| {
            tag.len() <= 64 && tag.strip_prefix('v').is_some_and(|tail| {
                !tail.is_empty()
                    && !tail.starts_with('.')
                    && !tail.contains("..")
                    && tail.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
                    })
            })
        })
        .ok_or_else(|| "В последнем релизе Ollama отсутствует корректная версия.".to_string())?;
    let asset = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset.get("name").and_then(serde_json::Value::as_str) == Some(asset_name)
            })
        })
        .ok_or_else(|| format!("В последнем релизе Ollama не найден файл {asset_name}."))?;
    let sha256 = asset
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or_else(|| {
            format!("Для файла {asset_name} отсутствует контрольная сумма SHA-256.")
        })?;

    Ok(VerifiedReleaseAsset {
        version: version.to_string(),
        url: format!(
            "https://github.com/ollama/ollama/releases/download/{version}/{asset_name}"
        ),
        sha256: sha256.to_string(),
    })
}

fn download_verified_asset(
    app: &tauri::AppHandle,
    url: &str,
    expected_sha256: &str,
    filename: &str,
) -> Result<PathBuf, String> {
    check_setup_cancelled()?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(1))
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
            check_setup_cancelled()?;
            let read = match response.read(&mut buffer) {
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                    check_setup_cancelled()?;
                    continue;
                }
                Err(_) => return Err("Загрузка установщика Ollama прервалась.".into()),
            };
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

fn run_cancellable(
    command: &mut Command,
    launch_error: &str,
) -> Result<std::process::ExitStatus, String> {
    check_setup_cancelled()?;
    let mut child = command
        .spawn()
        .map_err(|_| launch_error.to_string())?;
    loop {
        if is_ollama_setup_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED_MESSAGE.into());
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Не удалось проверить состояние установщика Ollama.".into());
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn install_windows(app: &tauri::AppHandle) -> Result<(), String> {
    check_setup_cancelled()?;
    if start_existing_cli() {
        return Ok(());
    }
    #[cfg(target_arch = "x86_64")]
    {
        emit_install_progress(app, "Проверяем последнюю стабильную версию Ollama…");
        let release = latest_ollama_release_asset("OllamaSetup.exe")?;
        emit_install_progress(
            app,
            format!("Скачиваем установщик Ollama {} для Windows…", release.version),
        );
        let installer = download_verified_asset(
            app,
            &release.url,
            &release.sha256,
            "OllamaSetup.exe",
        )?;
        emit_install_progress(app, "Проверяем и запускаем установщик Ollama…");
        let result = run_cancellable(
            Command::new(&installer)
                .args(["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
            "Не удалось запустить установщик Ollama для Windows.",
        )
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
    check_setup_cancelled()?;
    let open_existing = Command::new("open")
        .args(["-a", "Ollama"])
        .status()
        .is_ok_and(|status| status.success());
    if open_existing || start_existing_cli() {
        return Ok(());
    }
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        let destination = user_home()?.join("Applications").join("Ollama.app");
        emit_install_progress(app, "Проверяем последнюю стабильную версию Ollama…");
        let release = latest_ollama_release_asset("Ollama-darwin.zip")?;
        emit_install_progress(
            app,
            format!("Скачиваем Ollama {} для macOS…", release.version),
        );
        let archive = download_verified_asset(
            app,
            &release.url,
            &release.sha256,
            "Ollama-darwin.zip",
        )?;
        emit_install_progress(app, "Проверяем архив и устанавливаем Ollama…");
        let work_dir = archive.with_extension("unpacked");
        let mut destination_install_started = false;
        let result = (|| {
            let status = run_cancellable(
                Command::new("ditto")
                    .args(["-x", "-k"])
                    .arg(&archive)
                    .arg(&work_dir),
                "Не удалось распаковать Ollama для macOS.",
            )?;
            if !status.success() {
                return Err("Архив Ollama для macOS не удалось распаковать.".into());
            }
            let source = find_ollama_app(&work_dir)
                .ok_or_else(|| "В архиве не найдено приложение Ollama.".to_string())?;
            fs::create_dir_all(destination.parent().unwrap())
                .map_err(|_| "Не удалось создать папку приложений пользователя.".to_string())?;
            if destination.exists() {
                return Err("В ~/Applications уже есть Ollama.app; удалите или переместите его и повторите установку.".into());
            }
            destination_install_started = true;
            let status = run_cancellable(
                Command::new("ditto").arg(&source).arg(&destination),
                "Не удалось установить Ollama в папку пользователя.",
            )?;
            if !status.success() {
                return Err("Не удалось установить Ollama в папку пользователя.".into());
            }
            check_setup_cancelled()?;
            Command::new("open")
                .arg("-a")
                .arg(&destination)
                .spawn()
                .map_err(|_| "Ollama установлена, но не удалось запустить приложение.".to_string())?;
            Ok(())
        })();
        if destination_install_started && is_ollama_setup_cancelled() {
            let _ = fs::remove_dir_all(&destination);
        }
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
    check_setup_cancelled()?;
    let install_dir = user_home()?.join(".local/share/norman/ollama");
    let existing_binary = install_dir.join("ollama");
    if start_cli_at(&existing_binary) || start_existing_cli() {
        return Ok(());
    }
    #[cfg(target_arch = "x86_64")]
    {
        return install_linux_asset(app, &install_dir, "ollama-linux-amd64.tar.zst");
    }
    #[cfg(target_arch = "aarch64")]
    {
        return install_linux_asset(app, &install_dir, "ollama-linux-arm64.tar.zst");
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
) -> Result<(), String> {
    emit_install_progress(app, "Проверяем последнюю стабильную версию Ollama…");
    let release = latest_ollama_release_asset(asset)?;
    emit_install_progress(
        app,
        format!("Скачиваем Ollama {} для Linux…", release.version),
    );
    let archive = download_verified_asset(app, &release.url, &release.sha256, asset)?;
    emit_install_progress(app, "Проверяем архив и устанавливаем Ollama в папку пользователя…");
    let staging_dir = install_dir.with_extension("installing");
    let result = (|| {
        if staging_dir.exists() {
            fs::remove_dir_all(&staging_dir)
                .map_err(|_| "Не удалось очистить временную папку установки Ollama.".to_string())?;
        }
        fs::create_dir_all(&staging_dir)
            .map_err(|_| "Не удалось создать папку Ollama в профиле пользователя.".to_string())?;
        let status = run_cancellable(
            Command::new("tar")
                .args(["--zstd", "-xf"])
                .arg(&archive)
                .args(["-C"])
                .arg(&staging_dir),
            "Для распаковки Ollama в Linux требуются tar и zstd.",
        )?;
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
