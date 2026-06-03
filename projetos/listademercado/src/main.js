import { getState, addItem, toggleBought, removeItem, clearAll } from "./store.js";
import { renderList } from "./render.js";

const form = document.getElementById("add-form");
const input = document.getElementById("item-input");
const listEl = document.getElementById("list");
const clearBtn = document.getElementById("clear-all");

function refresh() {
  renderList(getState());
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const ok = addItem(input.value);
  if (!ok) return;
  input.value = "";
  refresh();
  input.focus();
});

listEl.addEventListener("change", (e) => {
  const target = e.target;
  if (target.dataset.action !== "toggle") return;
  toggleBought(target.dataset.id);
  refresh();
});

listEl.addEventListener("click", (e) => {
  const target = e.target.closest('[data-action="remove"]');
  if (!target) return;
  removeItem(target.dataset.id);
  refresh();
});

clearBtn.addEventListener("click", () => {
  if (!confirm("Apagar todos os itens da lista?")) return;
  clearAll();
  refresh();
});

refresh();
input.focus();
