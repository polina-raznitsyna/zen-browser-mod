# Zen Browser Mod

Мод для [Zen Browser](https://zen-browser.app), ставится через [Sine](https://github.com/CosmoCreeper/Sine). Правит боковую панель: важные и закреплённые вкладки, прокрутку, папки, перетаскивание. Каждая правка включается своей настройкой в окне мода.

Проверен на Zen 1.24.3b.

## Установка

В Zen: Настройки → Моды Sine, в поле установки вписать `polina-raznitsyna/zen-browser-mod`.

## Разработка

После клонирования один раз включить хук, который обновляет `updatedAt` в `theme.json` при каждом коммите. Без этого Sine не увидит новую версию.

```
git config core.hooksPath .githooks
```
