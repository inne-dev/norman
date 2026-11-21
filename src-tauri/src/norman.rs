use std::{sync::Mutex, time::Duration};

use reqwest::{Method, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use url::Host;

const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub(crate) struct NormanSession {
    value: Mutex<Option<StoredSession>>,
}

struct StoredSession {
    token: String,
    server_url: String,
}

impl NormanSession {
    pub(crate) fn token_for(&self, base: &Url) -> Result<Option<String>, String> {
        self.value
            .lock()
            .map(|session| {
                session
                    .as_ref()
                    .filter(|session| session.server_url == base.as_str())
                    .map(|session| session.token.clone())
            })
            .map_err(|_| "Не удалось прочитать сессию Norman.".to_string())
    }

    fn set_token(&self, token: String, base: &Url) -> Result<(), String> {
        *self
            .value
            .lock()
            .map_err(|_| "Не удалось сохранить сессию Norman.".to_string())? = Some(StoredSession {
            token,
            server_url: base.as_str().to_owned(),
        });
        Ok(())
    }

    fn take(&self) -> Result<Option<StoredSession>, String> {
        self.value
            .lock()
            .map(|mut session| session.take())
            .map_err(|_| "Не удалось завершить сессию Norman.".to_string())
    }

    fn clear(&self) {
        *self.value.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormanUser {
    pub(crate) email: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormanQuota {
    pub(crate) limit: u64,
    pub(crate) remaining: u64,
    pub(crate) percent_remaining: f64,
    #[serde(default)]
    pub(crate) resets_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormanSessionView {
    pub(crate) user: NormanUser,
    pub(crate) quota: NormanQuota,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    token: String,
    user: NormanUser,
    quota: NormanQuota,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    dev_code: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequest<'a> {
    email: &'a str,
    password: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRequest<'a> {
    email: &'a str,
    code: &'a str,
}

pub(crate) fn validate_server_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 2048 {
        return Err("Адрес сервера Norman слишком длинный.".into());
    }
    let url = Url::parse(raw.trim())
        .map_err(|_| "Введите корректный адрес сервера Norman.".to_string())?;
    let host = url
        .host()
        .ok_or_else(|| "В адресе сервера Norman не указан хост.".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Укажите только адрес сервера Norman без пути, параметров и учётных данных.".into(),
        );
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback_host(host)) {
        return Err(
            "Для сервера Norman требуется HTTPS. HTTP разрешён только для loopback-адресов.".into(),
        );
    }
    Ok(url)
}

pub(crate) fn api_url(base: &Url, path: &str) -> Result<Url, String> {
    let mut url = base.clone();
    url.set_path(&format!("/api/{path}"));
    Ok(url)
}

fn is_loopback_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(value) => value.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось подготовить соединение с сервером Norman.".to_string())
}

async fn send_json(
    server_url: &str,
    path: &str,
    method: Method,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<(StatusCode, Vec<u8>), String> {
    let base = validate_server_url(server_url)?;
    let endpoint = api_url(&base, path)?;
    let client = api_client()?;
    let mut request = client.request(method, endpoint).header("Accept", "application/json");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| {
            "Не удалось связаться с сервером Norman. Проверьте адрес и подключение.".to_string()
        })?;
    read_response(response).await
}

async fn read_response(mut response: Response) -> Result<(StatusCode, Vec<u8>), String> {
    let status = response.status();
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err("Ответ сервера Norman превышает допустимый размер.".into());
    }
    let mut bytes = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Не удалось прочитать ответ сервера Norman.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Ответ сервера Norman превышает допустимый размер.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}

pub(crate) fn api_error(status: StatusCode, bytes: &[u8]) -> String {
    let details = serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|body| {
            body.get("message")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|message| !message.trim().is_empty());
    details.unwrap_or_else(|| {
        if status == StatusCode::UNAUTHORIZED {
            "Сервер Norman отклонил запрос. Проверьте данные входа или войдите снова.".into()
        } else {
            format!("Сервер Norman вернул HTTP {}.", status.as_u16())
        }
    })
}

fn decode_success<T: for<'de> Deserialize<'de>>(
    status: StatusCode,
    bytes: &[u8],
) -> Result<T, String> {
    if !status.is_success() {
        return Err(api_error(status, bytes));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| "Сервер Norman вернул ответ неверного формата.".to_string())
}

fn save_auth_response(
    session: &NormanSession,
    response: AuthResponse,
    server_url: &str,
) -> Result<NormanSessionView, String> {
    if response.token.trim().is_empty() {
        return Err("Сервер Norman не вернул токен сессии.".into());
    }
    let base = validate_server_url(server_url)?;
    session.set_token(response.token, &base)?;
    Ok(NormanSessionView {
        user: response.user,
        quota: response.quota,
    })
}

#[tauri::command]
pub(crate) async fn norman_register(
    server_url: String,
    email: String,
    password: String,
) -> Result<Option<String>, String> {
    let email = email.trim();
    if email.is_empty() || email.len() > 320 || password.is_empty() || password.len() > 1024 {
        return Err("Введите корректный email и пароль.".into());
    }
    let body = serde_json::to_value(AuthRequest { email, password: &password })
        .map_err(|_| "Не удалось подготовить запрос регистрации.".to_string())?;
    let (status, bytes) =
        send_json(&server_url, "auth/register", Method::POST, None, Some(body)).await?;
    let response: RegisterResponse = decode_success(status, &bytes)?;
    Ok(response.dev_code.map(|code| match code {
        Value::String(value) => value,
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    }).filter(|code| !code.is_empty()))
}

#[tauri::command]
pub(crate) async fn norman_verify(
    server_url: String,
    email: String,
    code: String,
    session: State<'_, NormanSession>,
) -> Result<NormanSessionView, String> {
    let email = email.trim();
    let code = code.trim();
    if email.is_empty() || code.is_empty() || code.len() > 128 {
        return Err("Введите email и код подтверждения.".into());
    }
    let body = serde_json::to_value(VerifyRequest { email, code })
        .map_err(|_| "Не удалось подготовить запрос подтверждения.".to_string())?;
    let (status, bytes) =
        send_json(&server_url, "auth/verify", Method::POST, None, Some(body)).await?;
    let response: AuthResponse = decode_success(status, &bytes)?;
    save_auth_response(&session, response, &server_url)
}

#[tauri::command]
pub(crate) async fn norman_login(
    server_url: String,
    email: String,
    password: String,
    session: State<'_, NormanSession>,
) -> Result<NormanSessionView, String> {
    let email = email.trim();
    if email.is_empty() || email.len() > 320 || password.is_empty() || password.len() > 1024 {
        return Err("Введите email и пароль.".into());
    }
    let body = serde_json::to_value(AuthRequest { email, password: &password })
        .map_err(|_| "Не удалось подготовить запрос входа.".to_string())?;
    let (status, bytes) =
        send_json(&server_url, "auth/login", Method::POST, None, Some(body)).await?;
    let response: AuthResponse = decode_success(status, &bytes)?;
    save_auth_response(&session, response, &server_url)
}

#[tauri::command]
pub(crate) async fn norman_me(
    server_url: String,
    session: State<'_, NormanSession>,
) -> Result<Option<NormanSessionView>, String> {
    let base = validate_server_url(&server_url)?;
    let Some(token) = session.token_for(&base)? else {
        return Ok(None);
    };
    let (status, bytes) = send_json(&server_url, "me", Method::GET, Some(&token), None).await?;
    if status == StatusCode::UNAUTHORIZED {
        session.clear();
        return Err("Сессия Norman истекла. Войдите снова.".into());
    }
    let response: MeResponse = decode_success(status, &bytes)?;
    Ok(Some(NormanSessionView {
        user: response.user,
        quota: response.quota,
    }))
}

#[tauri::command]
pub(crate) async fn norman_logout(
    session: State<'_, NormanSession>,
) -> Result<(), String> {
    let Some(stored) = session.take()? else {
        return Ok(());
    };
    let (status, bytes) =
        send_json(&stored.server_url, "auth/logout", Method::POST, Some(&stored.token), None).await?;
    if !status.is_success() {
        return Err(api_error(status, &bytes));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user: NormanUser,
    quota: NormanQuota,
}

#[cfg(test)]
mod tests {
    use super::{api_url, validate_server_url, NormanSession};

    #[test]
    fn server_url_allows_https_and_http_loopback_only() {
        assert!(validate_server_url("https://accounts.example.com").is_ok());
        assert!(validate_server_url("http://127.0.0.1:8787").is_ok());
        assert!(validate_server_url("http://[::1]:8787").is_ok());
        assert!(validate_server_url("http://localhost:8787").is_ok());
        assert!(validate_server_url("http://accounts.example.com").is_err());
        assert!(validate_server_url("ftp://127.0.0.1:8787").is_err());
        assert!(validate_server_url("https://user:pass@example.com").is_err());
        assert!(validate_server_url("https://example.com/path").is_err());
    }

    #[test]
    fn endpoint_uses_fixed_api_path() {
        let base = validate_server_url("https://accounts.example.com").unwrap();
        assert_eq!(
            api_url(&base, "auth/login").unwrap().as_str(),
            "https://accounts.example.com/api/auth/login"
        );
    }

    #[test]
    fn session_token_is_bound_to_its_server() {
        let session = NormanSession::default();
        let original = validate_server_url("https://accounts.example.com").unwrap();
        let other = validate_server_url("https://other.example.com").unwrap();

        session.set_token("session-token".into(), &original).unwrap();

        assert_eq!(session.token_for(&original).unwrap().as_deref(), Some("session-token"));
        assert_eq!(session.token_for(&other).unwrap(), None);
    }
}
