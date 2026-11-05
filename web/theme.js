// Sets the colour theme before the page is first painted, so it never flashes the wrong one:
// the saved choice (see the theme button in app.js), else the system's. Loaded in <head>.
try {
  const t = localStorage.getItem('lucidly.theme');
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch {
  /* storage blocked: app.js applies the system theme */
}
