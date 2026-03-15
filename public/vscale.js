// Secret vertical scale: Ctrl+Shift+Minus/Plus to shrink/grow vertically 1%, Ctrl+Shift+0 to reset
// For non-standard screen proportions — adjusts vertical axis only
(function() {
    var sy = parseFloat(localStorage.getItem('_tsy') || '100');
    function apply() {
        document.body.style.transformOrigin = 'top left';
        document.body.style.transform = 'scaleY(' + (sy / 100) + ')';
    }
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply);
    document.addEventListener('keydown', function(e) {
        if (!(e.ctrlKey && e.shiftKey)) return;
        if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            sy = Math.max(10, sy - 1);
        } else if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            sy = Math.min(200, sy + 1);
        } else if (e.key === '0' || e.key === ')') {
            e.preventDefault();
            sy = 100;
        } else {
            return;
        }
        localStorage.setItem('_tsy', String(sy));
        apply();
    });
})();
