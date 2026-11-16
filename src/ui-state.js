export function savedThemePreference(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveTheme(preference, systemTheme) {
  return preference === 'light' || preference === 'dark'
    ? preference
    : systemTheme === 'light' ? 'light' : 'dark';
}

export function memoryGiB(bytes) {
  return bytes / 1024 ** 3;
}
