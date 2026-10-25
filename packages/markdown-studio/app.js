/* Minimal, dependency-free Markdown renderer for the preview pane. */
(function () {
  var src = document.getElementById('src');
  var out = document.getElementById('out');
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function render(md){
    var html = esc(md)
      .replace(/^### (.*)$/gm,'<h3>$1</h3>')
      .replace(/^## (.*)$/gm,'<h2>$1</h2>')
      .replace(/^# (.*)$/gm,'<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/`(.+?)`/g,'<code>$1</code>')
      .replace(/^- (.*)$/gm,'<li>$1</li>')
      .replace(/\n/g,'<br/>');
    return html.replace(/(<li>.*<\/li>)/g,'<ul>$1</ul>');
  }
  function update(){ out.innerHTML = render(src.value); }
  src.addEventListener('input', update);
  update();
})();
