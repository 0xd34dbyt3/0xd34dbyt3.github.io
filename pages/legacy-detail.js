// Build embeds a public ID/slug -> static page map. No API or secret is needed.
const map = JSON.parse(document.getElementById('legacy-map').textContent);
const params = new URLSearchParams(location.search);
const type = params.get('type');
const id = params.get('id');
const target = map[`${type}:${id}`];
if (target) {
    const url = new URL(target, location.origin);
    if (params.get('lang') === 'tr') url.pathname += 'tr.html';
    location.replace(url.href);
} else {
    document.getElementById('pageTitle').textContent = '404_NOT_FOUND';
    document.getElementById('pageSubtitle').textContent = 'The requested resource could not be located.';
}
