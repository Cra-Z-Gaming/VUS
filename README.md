I made this for myself and probably my whole school, but since my school likes to be a **BEAAACH** about games and websites, I'm not really supposed to share them anymore.

This is literally the only thing I'm good at, so I'm going to keep making them.

I don't mainly make these sites for myself, I make them for the little jits at school who just want something fun to do.


anyways, here is how to actually use this correctly/how to build it

first go to [STARTER BUTTON](https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/refs/heads/main/STARTER%20BUTTON), copy code, go to any html viewer and paste the code.
then just click the button and it should show my Hub and YT. theres also other tabs for tools and links.


---------------------------------------------------------------------------------------------------------------------------------

SUPER SIMPLE "HOW TO BUILD"

copy code from [STARTER BUTTON](https://raw.githubusercontent.com/Cra-Z-Gaming/VUS/refs/heads/main/STARTER%20BUTTON) then paste into a code viewer.


CODE VIEWER LINKS

[CodeBeautify](https://codebeautify.org/htmlviewer)

[HTMLOnlineViewer](https://html.onlineviewer.net/)

-----------------------------------------------------------------------------------------------------------------------------------

Starter Button code:

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

----------------------------------------------------------------------------------------------------------------------------------------

this project is free to make and is fully open source. i do not mind you using any code from VUS, but i do ask 2 things: 

1 - Credits: this can be my youtube @NotVladYT or my github profile github.com/Cra-Z-Gaming

2 - Donations: this is 100% optional but GREATLY appreciated: Cashapp $vlad118

Donations would definitely make me happy and motivated to make more projects or more buttons with code that live in VUS Hub
