// windows系统缩放适配
var isWin = (navigator.platform == "Win32") || (navigator.platform == "Windows");

if(isWin) {
  resetPixelRatio();

  window.addEventListener('resize', resetPixelRatio);
}

function resetPixelRatio() {
  let isAdaptive = localStorage.getItem('adapt_sys_scale') === '1';
  if(isAdaptive) {
    document.body.style = '';
    return;
  }

  let zoomSize = window.devicePixelRatio;
  if(zoomSize > 1.5) {
    document.body.style.zoom = 0.8;
    return;
  }

  document.body.style.zoom = 1;
}