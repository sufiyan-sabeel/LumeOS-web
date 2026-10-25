/* Hello Canvas - animated particle demo for LumeOS. */
(function () {
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0;
  var particles = [];

  function resize() {
    W = canvas.width = canvas.clientWidth;
    H = canvas.height = canvas.clientHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  for (var i = 0; i < 120; i++) {
    particles.push({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 1.2,
      vy: (Math.random() - 0.5) * 1.2,
      r: Math.random() * 2 + 1
    });
  }

  function frame() {
    ctx.fillStyle = 'rgba(11,15,26,0.25)';
    ctx.fillRect(0, 0, W, H);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(' + ((p.x + p.y) % 360) + ',80%,65%)';
      ctx.fill();
    }

    /* connecting lines */
    ctx.strokeStyle = 'rgba(110,168,254,0.15)';
    for (var a = 0; a < particles.length; a++) {
      for (var b = a + 1; b < particles.length; b++) {
        var dx = particles[a].x - particles[b].x;
        var dy = particles[a].y - particles[b].y;
        if (dx * dx + dy * dy < 6000) {
          ctx.beginPath();
          ctx.moveTo(particles[a].x, particles[a].y);
          ctx.lineTo(particles[b].x, particles[b].y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(frame);
  }
  frame();

  document.getElementById('notify').addEventListener('click', function () {
    if (window.LumeOS) {
      window.LumeOS.notifications.send('Hello Canvas', 'IPC bridge is working!');
    }
  });
})();
