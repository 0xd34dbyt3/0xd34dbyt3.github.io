/**
 * 0xDEADBYTE — Mouse-Responsive White Vortex Matrix Canvas Background
 * Reusable background animation for all pages
 */

(function initVortexBg() {
    // Ensure canvas element exists or inject it
    let canvas = document.getElementById('bgCanvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'bgCanvas';
        canvas.setAttribute('aria-hidden', 'true');
        document.body.prepend(canvas);
    }

    const ctx = canvas.getContext('2d');
    const CHARS = '01ABCDEF@#%&*></.\\|';
    const FS = 13;
    let W, H, cols, rows, grid, animId;
    let time = 0;

    let mouse = { x: 0.5, y: 0.5 };
    let smoothMouse = { x: 0.5, y: 0.5 };

    function updatePointer(clientX, clientY) {
        mouse.x = clientX / window.innerWidth;
        mouse.y = clientY / window.innerHeight;
    }

    document.addEventListener('mousemove', e => updatePointer(e.clientX, e.clientY));
    document.addEventListener('touchmove', e => {
        if (e.touches && e.touches[0]) {
            updatePointer(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: true });
    document.addEventListener('touchstart', e => {
        if (e.touches && e.touches[0]) {
            updatePointer(e.touches[0].clientX, e.touches[0].clientY);
        }
    }, { passive: true });

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
        cols = Math.ceil(W / (FS * 1.6));
        rows = Math.ceil(H / FS);
        grid = Array.from({ length: cols * rows }, () =>
            CHARS[Math.floor(Math.random() * CHARS.length)]
        );
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.font = `${FS}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        time += 0.012;

        smoothMouse.x += (mouse.x - smoothMouse.x) * 0.06;
        smoothMouse.y += (mouse.y - smoothMouse.y) * 0.06;

        const cx = smoothMouse.x;
        const cy = smoothMouse.y;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const nx = (col / cols) - cx;
                const ny = (row / rows) - cy;
                const dist  = Math.sqrt(nx * nx + ny * ny);
                const angle = Math.atan2(ny, nx);

                const wave = Math.sin(dist * 5 - time * 1.8 + angle * 1.5);
                const rawOp = (wave + 1) * 0.5;

                const cursorDist = Math.sqrt(
                    Math.pow((col / cols) - mouse.x, 2) +
                    Math.pow((row / rows) - mouse.y, 2)
                );
                const glowBoost = Math.max(0, 1 - cursorDist * 6) * 0.55;

                const distFactor = Math.max(0, 1 - Math.abs(dist - 0.38) * 3.2);
                const opacity = rawOp * distFactor * 0.30 + glowBoost;

                if (opacity < 0.015) continue;

                const idx = row * cols + col;
                if (Math.random() < 0.004) {
                    grid[idx] = CHARS[Math.floor(Math.random() * CHARS.length)];
                }

                ctx.fillStyle = `rgba(255,255,255,${Math.min(opacity, 0.85).toFixed(3)})`;
                ctx.fillText(grid[idx], col * FS * 1.6 + FS * 0.8, row * FS + FS);
            }
        }
        animId = requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener('resize', () => {
        cancelAnimationFrame(animId);
        resize();
        draw();
    });
})();
