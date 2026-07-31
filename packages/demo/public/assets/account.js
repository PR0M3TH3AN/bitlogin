const element = document.getElementById("bitlogin-widget");
element?.addEventListener("bitlogin-login", (event) => {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  console.info("[bitlogin] signed in", detail?.publicKey);
});
element?.addEventListener("bitlogin-logout", () => console.info("[bitlogin] signed out"));
