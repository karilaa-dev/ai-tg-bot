const themeKey = "conversation-theme";
const preferred = matchMedia("(prefers-color-scheme: dark)");
let saved: string | null = null;
try { saved = localStorage.getItem(themeKey); } catch { /* Storage can be disabled. */ }
let explicit = saved === "light" || saved === "dark" ? saved : null;
function apply(theme: string) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
  document.documentElement.dataset.theme = theme;
}
apply(explicit ?? (preferred.matches ? "dark" : "light"));
preferred.addEventListener("change", () => { if (!explicit) apply(preferred.matches ? "dark" : "light"); });
window.addEventListener("conversation-theme", () => {
  explicit = document.documentElement.classList.contains("dark") ? "light" : "dark";
  try { localStorage.setItem(themeKey, explicit); } catch { /* Keep the choice for this page. */ }
  apply(explicit);
});
window.addEventListener("storage", event => {
  if (event.key !== themeKey && event.key !== null) return;
  explicit = event.newValue === "light" || event.newValue === "dark" ? event.newValue : null;
  apply(explicit ?? (preferred.matches ? "dark" : "light"));
});
