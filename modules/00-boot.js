// R0a: first module. Small page helpers, moved unchanged from the inline script. Classic script: shares the page's global scope.
const $=i=>document.getElementById(i);
const toast=m=>{ $('toast').textContent=m; setTimeout(()=>{if($('toast').textContent===m)$('toast').textContent=''},4500)};
const tg=id=>{const e=$(id);e.style.display=e.style.display==='block'?'none':'block'};
