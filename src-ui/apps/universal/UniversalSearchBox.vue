<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';

const props = defineProps<{
  query: string;
}>();

const emit = defineEmits<{
  search: [query: string];
  clear: [];
}>();

const localQuery = ref(props.query);
const inputRef = ref<HTMLInputElement | null>(null);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

// Состояние хоста — эхо уже отправленного (и нормализованного: trim, <3 символов → '')
// запроса, оно приходит позже, чем пользователь допечатывает. Пока поле в фокусе,
// перезапись откатывала бы набранные символы, поэтому внешнее значение принимаем
// только без фокуса (сброс поиска из другой панели/команды).
watch(() => props.query, (query) => {
  if (inputRef.value && document.activeElement === inputRef.value) return;
  localQuery.value = query;
});

function onInput(value: string): void {
  localQuery.value = value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emit('search', value);
  }, 400);
}

function submit(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = undefined;
  emit('search', localQuery.value);
}

function clear(): void {
  localQuery.value = '';
  if (debounceTimer) clearTimeout(debounceTimer);
  emit('clear');
}

onUnmounted(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
});
</script>

<template>
  <div class="search">
    <input
      ref="inputRef"
      :value="localQuery"
      type="text"
      placeholder="Поиск по метаданным"
      aria-label="Поиск по метаданным"
      autocomplete="off"
      spellcheck="false"
      @input="onInput(($event.target as HTMLInputElement).value)"
      @keydown.enter="submit"
      @keydown.escape="clear"
    />
    <button
      v-if="localQuery"
      class="clear"
      type="button"
      title="Очистить поиск"
      aria-label="Очистить поиск"
      @click="clear"
    >
      <span class="codicon codicon-close" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  margin-top: 8px;
  min-height: 26px;
}
input {
  width: 100%;
  height: 26px;
  box-sizing: border-box;
  padding: 0 30px 0 10px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 5px;
  font: inherit;
  line-height: 24px;
  outline: none;
}
input:focus {
  border-color: var(--vscode-focusBorder);
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
input::placeholder {
  color: var(--vscode-input-placeholderForeground);
  opacity: 1;
}
button.clear {
  position: absolute;
  top: 1px;
  right: 4px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  color: var(--vscode-icon-foreground);
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
}
button.clear:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
</style>
