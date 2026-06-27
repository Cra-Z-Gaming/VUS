I made this for myself and probably my whole school, but since my school likes to be a **BEAAACH** about games and websites, I'm not really supposed to share them anymore.

This is literally the only thing I'm good at, so I'm going to keep making them.

I don't mainly make these sites for myself, I make them for the little jits at school who just want something fun to do.


anyways, here is how to actually use this correctly/how to build it

first go to index.html, copy code then go to any html viewer and paste the hub.html code.
then just click the button and it should show my Hub and YT. theres also other tabs for tools and links.


---------------------------------------------------------------------------------------------------------------------------------

SUPER SIMPLE "HOW TO BUILD"

copy code from hub.html then paste into a code viewer.


-----------------------------------------------------------------------------------------------------------------------------------

hub.html / Starter Button code:

```text

<button id="hub">Open</button>

<script>
document.getElementById("hub").onclick = async () => {
    const hubCode = await fetch(
        "https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/main/index.html?v=" + Date.now(),
    ).then(r => r.text());

    const win = window.open("about:blank", "_blank");

    win.document.open();
    win.document.write(hubCode);
    win.document.close();
};
</script>

```
