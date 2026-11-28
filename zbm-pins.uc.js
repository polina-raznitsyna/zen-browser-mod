/*
 * Закреплённые вкладки вне папок стоят на месте, а папки прокручиваются
 * вместе с обычными вкладками.
 *
 * У Zen плитки закреплённых и папки лежат в одной секции, обычные вкладки в
 * соседней, и прокручивается всё это одним списком. Стилями нельзя оставить
 * на месте часть детей секции, а переносить папки в другую секцию нельзя: на
 * их месте в документе держится вся логика Zen.
 *
 * Поэтому секция закреплённых получает теневое дерево с двумя слотами. В
 * первый попадают вкладки верхнего уровня: он лежит в обёртке, которая
 * стоит над прокруткой и сама раскладывает плитки сеткой. Во второй всё
 * остальное: папки и разделитель остаются в прокручиваемом списке. Сами
 * вкладки и папки в документе не двигаются, меняется только место, где они
 * рисуются.
 *
 * Обёртка позиционирована абсолютно относительно arrowscrollbox, поэтому
 * прокрутка её не двигает и не обрезает. Место под неё держит отступ
 * arrowscrollbox, равный её высоте.
 *
 * Работает, когда включены неподвижные закреплённые, сетка закреплённых и
 * сама эта настройка, а панель развёрнута. Иначе слоты пусты и секция
 * рисуется как у Zen. Убрать теневое дерево с элемента нельзя, поэтому в
 * выключенном состоянии оно остаётся, но ни на что не влияет.
 *
 * Сверено с исходниками Zen 1.24.3b (ZenSpace.mjs, zen-workspaces.css) и
 * arrowscrollbox из Firefox 160.
 */
(() => {
  "use strict";

  const PREF_STICKY = "mod.zbm.pins.sticky";
  const PREF_GRID = "mod.zbm.pins.grid";
  const PREF_SPLIT = "mod.zbm.pins.folders-scroll";
  const PREFS = [PREF_STICKY, PREF_GRID, PREF_SPLIT];

  const XHTML = "http://www.w3.org/1999/xhtml";
  const SLOT = "zbm-tiles";
  const HEIGHT_VAR = "--zbm-tiles-height";

  // Вид обёртки. Пока секция не помечена zbm-split, обёртка прозрачна для
  // раскладки. Проекция при перетаскивании рисуется здесь же: в такой секции
  // вкладка верхнего уровня всегда встаёт в сетку плиток.
  const SHADOW_CSS = `
    #zbm-tiles {
      display: contents;
    }
    :host([zbm-split]) #zbm-tiles {
      display: grid;
      grid-template-columns: repeat(var(--zbm-essential-columns, var(--zbm-pin-count-columns, 3)), minmax(0, 1fr));
      gap: var(--zen-space-4);
      align-content: start;
      position: absolute;
      inset-block-start: 0;
      inset-inline: 0;
      padding-inline: var(--zen-toolbox-padding);
      box-sizing: border-box;
      /* Плиток может оказаться больше, чем влезает: тогда сетка прокручивается
         сама и оставляет место списку. Вбок она не прокручивается, иначе
         горизонтальный жест не дошёл бы до перелистывания пространств. */
      max-height: 50vh;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-width: none;
    }
    /* Низ обёртки лежит внутри неё самой: курсор над ним остаётся в
       закреплённых и для мода, и для Zen. Признаки filled и rows ставит
       скрипт: есть ли в сетке видимая плитка и есть ли под ней папки.

       Над папками стоит разделитель, такой же, как у Zen между закреплёнными
       и обычными вкладками: полоса той же высоты с линией посередине. Без
       папок сразу под плитками идёт разделитель самого Zen, поэтому остаётся
       только обычный зазор сетки. */
    :host([zbm-split]) #zbm-tiles[filled]:not([rows]) {
      padding-block-end: var(--zen-space-4);
    }
    :host([zbm-split]) #zbm-tiles[filled][rows]::after {
      content: "";
      order: 2;
      grid-column: 1 / -1;
      height: var(--zen-size-22, 22px);
      background: linear-gradient(light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)) 0 0) no-repeat;
      background-size: calc(100% - 2 * var(--zen-space-5, 5px) - var(--zen-space-4, 4px)) 1px;
      background-position: calc(var(--zen-space-5, 5px) + var(--zen-space-4, 4px)) center;
    }
    :host([zbm-split][zbm-pins-anim]) #zbm-tiles {
      overflow: clip;
    }
    :host([zbm-split][zbm-gap]) #zbm-tiles::before {
      content: "";
      order: 1;
      box-sizing: border-box;
      height: var(--tab-min-height);
      margin: var(--tab-margin-block);
      border-radius: var(--border-radius-medium);
      corner-shape: superellipse(var(--zen-squircle-value));
      background: color-mix(in srgb, currentColor 6%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 9%, transparent);
    }
  `;

  const root = document.documentElement;
  const getPref = name => Services.prefs.getBoolPref(name, false);

  let disposed = false;
  let readyTimer = null;
  let sheet = null;
  const cleanups = [];
  // Секция закреплённых → всё, что для неё заведено.
  const states = new Map();

  const wanted = () =>
    PREFS.every(getPref) && root.getAttribute("zen-sidebar-expanded") === "true";

  /** Обёртка плиток секции. Теневое дерево заводится один раз и остаётся. */
  function tilesOf(section) {
    let shadow = section.shadowRoot;
    if (!shadow) {
      shadow = section.attachShadow({ mode: "open" });
      const tiles = document.createElementNS(XHTML, "div");
      tiles.id = "zbm-tiles";
      const tilesSlot = document.createElementNS(XHTML, "slot");
      tilesSlot.name = SLOT;
      tiles.append(tilesSlot);
      shadow.append(tiles, document.createElementNS(XHTML, "slot"));
    }
    // Чужое теневое дерево не трогаем.
    const tiles = shadow.getElementById("zbm-tiles");
    if (tiles) {
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(SHADOW_CSS);
      }
      // Дерево могло остаться от прошлой загрузки мода со старыми стилями.
      shadow.adoptedStyleSheets = [sheet];
    }
    return tiles;
  }

  /** Вкладки верхнего уровня уходят в слот плиток, всё остальное остаётся в списке. */
  function assign(section) {
    for (const child of section.children) {
      if (gBrowser.isTab(child) && child.getAttribute("slot") !== SLOT) {
        child.setAttribute("slot", SLOT);
      }
    }
  }

  function unassign(node) {
    if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute("slot") === SLOT) {
      node.removeAttribute("slot");
    }
  }

  const isShown = element => element.getBoundingClientRect().height > 0;

  /**
   * Высота места над прокруткой равна высоте обёртки. Что у обёртки внизу,
   * зависит от того, есть ли в сетке видимые плитки и видимые папки под ней.
   */
  function syncHeight(state) {
    const { section, tiles, host } = state;
    // Проекция при перетаскивании занимает место плитки.
    let filled = section.hasAttribute("zbm-gap");
    let rows = false;
    for (const child of section.children) {
      if (child.getAttribute("slot") === SLOT) {
        filled ||= isShown(child);
      } else if (child.isZenFolder || child.hasAttribute("split-view-group")) {
        rows ||= isShown(child);
      }
    }
    tiles.toggleAttribute("filled", filled);
    tiles.toggleAttribute("rows", rows);
    host.toggleAttribute("zbm-rows", filled && rows);
    const value = `${tiles.getBoundingClientRect().height}px`;
    if (host.style.getPropertyValue(HEIGHT_VAR) !== value) {
      host.style.setProperty(HEIGHT_VAR, value);
    }
  }

  function activate(workspace) {
    const section = workspace.pinnedTabsContainer;
    const host = workspace.scrollbox;
    if (!section || !host || states.has(section)) {
      return;
    }
    const tiles = tilesOf(section);
    if (!tiles) {
      return;
    }
    const state = { section, host, tiles };

    state.mutations = new MutationObserver(records => {
      assign(section);
      syncHeight(state);
      for (const record of records) {
        for (const node of record.removedNodes) {
          // Вкладка могла уже встать в такую же секцию другого пространства.
          if (!states.has(node.parentElement)) {
            unassign(node);
          }
        }
      }
    });
    state.mutations.observe(section, { childList: true });

    state.resizes = new ResizeObserver(() => syncHeight(state));
    state.resizes.observe(tiles);

    // Прокручен ли список: по этому признаку chrome.css рисует линию под
    // плитками. Штатный признак Zen здесь не годится: он смотрит на первый
    // элемент секции, а в сетке это скрытый служебный элемент.
    state.scroller = host.scrollbox;
    state.onScroll = () => {
      const scrolled = state.scroller.scrollTop > 0;
      if (scrolled !== host.hasAttribute("zbm-scrolled")) {
        host.toggleAttribute("zbm-scrolled", scrolled);
      }
    };
    state.scroller?.addEventListener("scroll", state.onScroll, { passive: true });

    // Выбранную вкладку Zen подводит в видимую часть списка. Плитка стоит
    // вне прокрутки, и попытка подвести её дёргала бы список к началу.
    state.canScroll = host._canScrollToElement;
    state.canScrollWrapper = element =>
      !(element?.parentElement === section && element.getAttribute("slot") === SLOT) &&
      state.canScroll.call(host, element);
    host._canScrollToElement = state.canScrollWrapper;

    // Живая перестановка и сворачивание меняют состав сетки и сразу снимают
    // раскладку, не дожидаясь наблюдателей. Через это свойство они просят
    // разложить вкладки по слотам и обновить высоту немедленно.
    section._zbmSyncTiles = () => {
      assign(section);
      syncHeight(state);
    };

    states.set(section, state);
    assign(section);
    section.setAttribute("zbm-split", "");
    host.setAttribute("zbm-split", "");
    syncHeight(state);
    if (state.scroller) {
      state.onScroll();
    }
  }

  function deactivate(section) {
    const state = states.get(section);
    if (!state) {
      return;
    }
    states.delete(section);
    state.mutations.disconnect();
    state.resizes.disconnect();
    state.scroller?.removeEventListener("scroll", state.onScroll);
    state.host.removeAttribute("zbm-scrolled");
    state.host.removeAttribute("zbm-rows");
    state.tiles.removeAttribute("rows");
    if (state.host._canScrollToElement === state.canScrollWrapper) {
      state.host._canScrollToElement = state.canScroll;
    }
    delete section._zbmSyncTiles;
    section.removeAttribute("zbm-split");
    state.host.removeAttribute("zbm-split");
    state.host.style.removeProperty(HEIGHT_VAR);
    state.tiles.removeAttribute("filled");
    for (const child of section.children) {
      unassign(child);
    }
  }

  function sync() {
    if (disposed) {
      return;
    }
    const on = wanted();
    const live = new Set();
    for (const workspace of document.querySelectorAll("zen-workspace")) {
      const section = workspace.pinnedTabsContainer;
      if (!section) {
        // Пространство ещё не собрано, придёт следующим событием.
        continue;
      }
      live.add(section);
      if (on) {
        activate(workspace);
      }
    }
    for (const section of [...states.keys()]) {
      if (!on || !live.has(section)) {
        deactivate(section);
      }
    }
  }

  function guardedSync() {
    try {
      sync();
    } catch (error) {
      console.error("[zen-browser-mod] pinned tiles layout failed:", error);
    }
  }

  function install() {
    const prefObserver = { observe: guardedSync };
    for (const pref of PREFS) {
      Services.prefs.addObserver(pref, prefObserver);
    }
    // Панель сворачивают и разворачивают.
    const rootObserver = new MutationObserver(guardedSync);
    rootObserver.observe(root, {
      attributes: true,
      attributeFilter: ["zen-sidebar-expanded"],
    });
    // Пространства создают и удаляют.
    const strip = document.getElementById("tabbrowser-arrowscrollbox");
    const stripObserver = new MutationObserver(guardedSync);
    if (strip) {
      stripObserver.observe(strip, { childList: true });
    }
    window.addEventListener("ZenWorkspacesUIUpdate", guardedSync);
    cleanups.push(() => {
      for (const pref of PREFS) {
        Services.prefs.removeObserver(pref, prefObserver);
      }
      rootObserver.disconnect();
      stripObserver.disconnect();
      window.removeEventListener("ZenWorkspacesUIUpdate", guardedSync);
    });
    guardedSync();
  }

  function uninstall() {
    disposed = true;
    clearTimeout(readyTimer);
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    for (const section of [...states.keys()]) {
      try {
        deactivate(section);
      } catch (error) {
        console.error("[zen-browser-mod] pinned tiles cleanup failed:", error);
      }
    }
  }

  // Скрипт может загрузиться раньше, чем Zen соберёт панель вкладок.
  let attempts = 0;
  function whenReady() {
    if (disposed) {
      return;
    }
    let ready = false;
    try {
      ready = !!(window.gBrowser?.tabContainer && window.gZenWorkspaces?.activeWorkspaceElement);
    } catch {}
    if (ready) {
      try {
        install();
      } catch (error) {
        console.error("[zen-browser-mod] pinned tiles layout failed to start:", error);
        uninstall();
      }
    } else if (attempts++ < 150) {
      readyTimer = setTimeout(whenReady, 200);
    }
  }
  whenReady();

  window.addUnloadListener?.(uninstall);
})();
