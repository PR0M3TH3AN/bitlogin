// For the embedded signer's page (docs/sign-in-window.md §SW6): if one of the signer's files fails to arrive,
// the page loads itself again, once.
//
// A deploy replaces the signer's files together. A page that fetched one just before and the rest just after
// gets a file that is no longer there, and would sit silent in a site that is waiting for it. The browser says
// so on the script that could not be loaded; this listens for that. It is a script of its own, and not part of
// the signer, because the signer is exactly what did not load. It runs before the signer does, and changes
// nothing about when the signer starts.
//
// The mark that it has loaded itself again is in the page's own address, where nothing has to be stored. A
// second failure is left as it is: the site hears nothing, and says so in its own words.
const start = document.getElementById("start");
start?.addEventListener(
  "error",
  () => {
    const here = new URL(location.href);
    if (here.searchParams.has("again")) return;
    here.searchParams.set("again", "1");
    location.replace(here.href);
  },
  { once: true }
);
