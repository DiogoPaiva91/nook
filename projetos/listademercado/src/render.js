const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty-state");
const counterEl = document.getElementById("counter");
const clearBtn = document.getElementById("clear-all");

function sortForDisplay(items) {
  const pendentes = items
    .filter((i) => !i.bought)
    .sort((a, b) => b.createdAt - a.createdAt);
  const comprados = items
    .filter((i) => i.bought)
    .sort((a, b) => b.createdAt - a.createdAt);
  return [...pendentes, ...comprados];
}

function buildItemNode(item) {
  const li = document.createElement("li");
  li.className = "list-item" + (item.bought ? " bought" : "");
  li.dataset.id = item.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "list-item__checkbox";
  checkbox.checked = item.bought;
  checkbox.dataset.action = "toggle";
  checkbox.dataset.id = item.id;
  checkbox.setAttribute("aria-label", `Marcar ${item.name} como comprado`);

  const name = document.createElement("span");
  name.className = "list-item__name";
  name.textContent = item.name;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "list-item__remove";
  remove.dataset.action = "remove";
  remove.dataset.id = item.id;
  remove.setAttribute("aria-label", `Remover ${item.name}`);
  remove.textContent = "×";

  li.append(checkbox, name, remove);
  return li;
}

export function renderList(state) {
  const total = state.items.length;
  const comprados = state.items.filter((i) => i.bought).length;

  if (total === 0) {
    listEl.hidden = true;
    listEl.replaceChildren();
    emptyEl.hidden = false;
    counterEl.hidden = true;
    counterEl.textContent = "";
    clearBtn.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  listEl.hidden = false;
  counterEl.hidden = false;
  counterEl.textContent = `${comprados} de ${total} itens`;
  clearBtn.hidden = false;

  const ordered = sortForDisplay(state.items);
  const fragment = document.createDocumentFragment();
  for (const item of ordered) fragment.appendChild(buildItemNode(item));
  listEl.replaceChildren(fragment);
}
