// Click a screenshot to see it full size; Esc or a click closes it.
(() => {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.hidden = true;
  box.innerHTML = "<img alt=\"\">";
  document.body.appendChild(box);
  const img = box.querySelector("img");
  document.addEventListener("click", (e) => {
    const shot = e.target.closest("img.shot");
    if (shot) { img.src = shot.src; img.alt = shot.alt; box.hidden = false; return; }
    if (!box.hidden) box.hidden = true;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") box.hidden = true; });
})();

// Кнопка сбора ЮMoney. Форма платёжного сервиса вставляется только по клику: пока её не
// попросили, страница не обращается ни к одному чужому домену, то есть сайт ничего о посетителе
// никуда не отдаёт, пока тот сам не решит поддержать проект.
(() => {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-frame]");
    if (!btn) return;
    const src = btn.dataset.frame;
    if (!src.startsWith("https://yoomoney.ru/")) return; // адрес только свой
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.title = btn.textContent;
    frame.width = 330;
    frame.height = 50;
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("allowtransparency", "true");
    btn.replaceWith(frame);
  });
})();
