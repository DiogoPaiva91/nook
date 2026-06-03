import { load, save } from "./storage.js";

const state = load();

function persist() {
  save(state);
}

export function getState() {
  return state;
}

export function addItem(name) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  state.items.unshift({
    id: crypto.randomUUID(),
    name: trimmed,
    bought: false,
    createdAt: Date.now(),
  });
  persist();
  return true;
}

export function toggleBought(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  item.bought = !item.bought;
  persist();
}

export function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  persist();
}

export function clearAll() {
  state.items = [];
  persist();
}
