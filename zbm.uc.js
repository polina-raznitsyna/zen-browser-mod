/*
 * Живая перестановка вкладок при перетаскивании.
 *
 * Куда упадёт вкладка, по-прежнему решает Zen. Скрипт только показывает это
 * иначе: вместо линии-индикатора соседние вкладки расступаются, а на месте
 * будущей вкладки стоит её проекция. Проекция это псевдоэлемент контейнера,
 * поставленный в нужное место через order, поэтому раскладку считает сам
 * браузер: папка растёт под вкладку, сетка перестраивается.
 *
 * Работает для одной перетаскиваемой вкладки. Папки, важные вкладки и
 * мультивыделение остаются на штатном индикаторе Zen. При любой ошибке
 * скрипт убирает своё и не мешает штатному перетаскиванию.
 *
 * Сверено с исходниками Zen 1.24.3b: ZenDragAndDrop.js.
 */
(() => {
  "use strict";

  const PREF_LIVE = "mod.zbm.dnd.live-reorder";
  const PREF_GRID = "mod.zbm.pins.grid";
  const PREF_SPACE_ROW = "mod.zbm.dnd.space-row-no-drop";

  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const ROW_SELECTOR =
    ".tabbrowser-tab, .tab-group-label-container, .pinned-tabs-container-separator, #tabbrowser-arrowscrollbox-periphery";
  const SPACE_ROW_SELECTOR = ".zen-current-workspace-indicator";
  const MOVE_MS = 140;
  const MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";
  // Zen округляет координату линии, поэтому границы сравниваем с допуском.
  const EDGE_TOLERANCE = 2;

  const root = document.documentElement;
  const getPref = name => Services.prefs.getBoolPref(name, false);

  let dnd = null;
  const originals = {};
  // Аргументы последнего _placeDropIndicator за текущий dragover: признак
  // того, что Zen в этот момент показывает линию, и её координата.
  let pendingIndicator = null;
  // Текущая проекция: { node, before, grid, container, tagged, draggedTab }.
  let gap = null;
  let dragSize = 0;
  let skipDropTransition = false;
  const running = new Map();

  const reduceMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const activeWorkspace = () => window.gZenWorkspaces?.activeWorkspaceElement;

  const pinnedSection = () =>
    activeWorkspace()?.querySelector(".zen-workspace-pinned-tabs-section");

  /** Все видимые строки активного пространства: то, что может сдвигаться. */
  function rows() {
    const workspace = activeWorkspace();
    if (!workspace) {
      return [];
    }
    return [...workspace.querySelectorAll(ROW_SELECTOR)].filter(
      // Вкладка внутри вкладки это glance, она едет вместе с родителем.
      el => !el.parentElement.closest(".tabbrowser-tab")
    );
  }

  const measure = list =>
    new Map(list.map(el => [el, el.getBoundingClientRect()]));

  /**
   * Доводит строки от старых мест к новым. Раскладка уже поменялась,
   * поэтому каждая строка стартует со смещением к прежнему месту и едет в ноль.
   */
  function glide(list, before) {
    for (const animation of running.values()) {
      animation.cancel();
    }
    running.clear();
    if (reduceMotion()) {
      return;
    }
    for (const el of list) {
      const was = before.get(el);
      const now = el.getBoundingClientRect();
      if (!was?.height || !now.height) {
        continue;
      }
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        continue;
      }
      const animation = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: MOVE_MS, easing: MOVE_EASING }
      );
      running.set(el, animation);
      animation.finished.then(
        () => running.get(el) === animation && running.delete(el),
        () => {}
      );
    }
  }

  function removeGapAttributes() {
    if (!gap) {
      return;
    }
    gap.container.removeAttribute("zbm-gap");
    for (const el of gap.tagged) {
      el.removeAttribute("zbm-after");
    }
    gap.draggedTab.removeAttribute("zbm-dragging");
    root.removeAttribute("zbm-live-dnd");
    gap = null;
  }

  function clearGap(animate) {
    if (!gap) {
      return;
    }
    const list = animate ? rows() : [];
    const before = measure(list);
    removeGapAttributes();
    glide(list, before);
  }

  /**
   * Ставит проекцию до или после node. Все следующие за ней соседи получают
   * order: 1, как и сама проекция, поэтому она встаёт ровно между ними и
   * предыдущими. Соседей со своим order (кнопка новой вкладки) не трогаем.
   */
  function showGap(target, draggedTab) {
    if (gap?.node === target.node && gap.before === target.before) {
      return;
    }
    const container = target.node.parentElement;
    if (!container) {
      clearGap(true);
      return;
    }
    const list = rows();
    const before = measure(list);
    removeGapAttributes();

    root.style.setProperty("--zbm-gap-size", `${dragSize}px`);
    const tagged = [];
    let sibling = target.before ? target.node : target.node.nextElementSibling;
    for (; sibling; sibling = sibling.nextElementSibling) {
      if (getComputedStyle(sibling).order === "0") {
        sibling.setAttribute("zbm-after", "");
        tagged.push(sibling);
      }
    }
    container.setAttribute("zbm-gap", "");
    draggedTab.setAttribute("zbm-dragging", "");
    root.setAttribute("zbm-live-dnd", "");
    gap = { ...target, container, tagged, draggedTab };

    glide(list, before);
  }

  const near = (a, b) => Math.abs(a - b) <= EDGE_TOLERANCE;

  /** Строка заголовка папки сама проекцию не держит: до неё и после свёрнутой папки место принадлежит папке. */
  function normalizeTarget(node, before) {
    if (node.classList.contains("tab-group-label-container")) {
      const folder = node.parentElement;
      if (before || folder.hasAttribute("collapsed")) {
        return { node: folder, before };
      }
    }
    if (before && getComputedStyle(node).order !== "0") {
      return null;
    }
    return { node, before };
  }

  /**
   * Переводит решение Zen в место для проекции. Сначала верим элементу,
   * который Zen выбрал целью, если линия стоит на его границе. Если нет,
   * ищем строку, на чьей границе стоит линия.
   */
  function targetFromIndicator(draggedTab, y) {
    const data = draggedTab._dragData;
    const element = data?.dropElement;
    const before = !!data?.dropBefore;

    if (element && element !== draggedTab) {
      if (gBrowser.isTab(element)) {
        const rect = element.getBoundingClientRect();
        if (rect.height && near(before ? rect.top : rect.bottom, y)) {
          return { node: element, before };
        }
      } else if (element.isZenFolder) {
        const label = element.querySelector(":scope > .tab-group-label-container");
        const rect = label?.getBoundingClientRect();
        if (rect?.height && near(before ? rect.top : rect.bottom, y)) {
          return normalizeTarget(label, before);
        }
      }
    }

    const candidates = rows()
      .filter(el => el !== draggedTab)
      .map(el => [el, el.getBoundingClientRect()])
      .filter(([, rect]) => rect.height);
    for (const [el, rect] of candidates) {
      if (near(rect.top, y)) {
        return normalizeTarget(el, true);
      }
    }
    for (const [el, rect] of candidates) {
      if (near(rect.bottom, y)) {
        return normalizeTarget(el, false);
      }
    }
    return null;
  }

  /**
   * Цель внутри сетки закреплённых. Штатная логика Zen считает список
   * вертикальным и в сетке ошибается, поэтому здесь цель выбирается по
   * плитке под курсором: левая половина ставит перед ней, правая после.
   */
  function targetFromGrid(event, draggedTab) {
    if (!getPref(PREF_GRID)) {
      return null;
    }
    const section = pinnedSection();
    if (!section?.contains(event.target)) {
      return null;
    }
    const tile = event.target.closest?.(".tabbrowser-tab");
    if (tile && tile !== draggedTab && tile.parentElement === section) {
      const rect = tile.getBoundingClientRect();
      return {
        node: tile,
        before: event.clientX < rect.left + rect.width / 2,
        grid: true,
      };
    }
    if (event.target !== section) {
      return null;
    }
    // Курсор над самой проекцией или над пустым местом в ряду плиток.
    if (gap?.grid && gap.container === section) {
      return gap;
    }
    const inRow = [...section.children].filter(el => {
      if (el === draggedTab || !gBrowser.isTab(el)) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.height && event.clientY >= rect.top && event.clientY < rect.bottom;
    });
    if (!inRow.length) {
      return null;
    }
    const left = inRow.filter(el => el.getBoundingClientRect().right <= event.clientX);
    return left.length
      ? { node: left.at(-1), before: false, grid: true }
      : { node: inRow[0], before: true, grid: true };
  }

  function canDragLive(draggedTab) {
    return (
      getPref(PREF_LIVE) &&
      dragSize > 0 &&
      root.getAttribute("zen-sidebar-expanded") === "true" &&
      draggedTab &&
      gBrowser.isTab(draggedTab) &&
      draggedTab.ownerGlobal === window &&
      !draggedTab.hasAttribute("zen-essential") &&
      !draggedTab.group?.hasAttribute("split-view-group") &&
      draggedTab._dragData?.movingTabs?.length === 1
    );
  }

  /** После того как Zen обработал dragover: показать, передвинуть или убрать проекцию. */
  function reconcile(event) {
    const indicator = pendingIndicator;
    pendingIndicator = null;
    const draggedTab = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!canDragLive(draggedTab)) {
      clearGap(true);
      return;
    }

    const gridTarget = targetFromGrid(event, draggedTab);
    if (gridTarget) {
      // Zen на каждом dragover пересчитывает цель по-своему, возвращаем нашу.
      draggedTab._dragData.dropElement = gridTarget.node;
      draggedTab._dragData.dropBefore = gridTarget.before;
      showGap(gridTarget, draggedTab);
      return;
    }

    if (indicator) {
      const target = targetFromIndicator(draggedTab, indicator.top);
      if (target) {
        showGap(target, draggedTab);
      } else {
        clearGap(true);
      }
    } else if (!window.gZenPinnedTabManager?._dragIndicator?.isConnected) {
      // Линии нет: Zen подсвечивает папку целиком или цели нет вовсе.
      clearGap(true);
    }
  }

  function guarded(step) {
    try {
      step();
    } catch (error) {
      console.error("[zen-browser-mod] live reorder failed:", error);
      try {
        removeGapAttributes();
      } catch {}
    }
  }

  /** Строка пространства перестаёт быть местом для броска, пока включена настройка. */
  function syncSpaceRows() {
    const off = getPref(PREF_SPACE_ROW);
    for (const row of document.querySelectorAll(SPACE_ROW_SELECTOR)) {
      row.classList.toggle("zen-drop-target", !off);
    }
  }

  const wrappers = {
    startTabDrag(event, tab, ...args) {
      const result = originals.startTabDrag.call(this, event, tab, ...args);
      guarded(() => {
        syncSpaceRows();
        dragSize = gBrowser.isTab(tab) ? tab.getBoundingClientRect().height : 0;
      });
      return result;
    },

    _placeDropIndicator(options) {
      pendingIndicator = options;
      return originals._placeDropIndicator.call(this, options);
    },

    handle_dragover(event) {
      pendingIndicator = null;
      const result = originals.handle_dragover.call(this, event);
      guarded(() => reconcile(event));
      return result;
    },

    // Перед броском раскладка возвращается к исходной: Zen сам переносит
    // вкладку и сам считает, куда приземлить её изображение.
    handle_drop(event) {
      const wasLive = !!gap;
      guarded(() => clearGap(false));
      skipDropTransition = wasLive;
      try {
        return originals.handle_drop.call(this, event);
      } finally {
        skipDropTransition = false;
      }
    },

    // Штатная анимация раздвигает соседей уже после броска. С проекцией они
    // стоят на местах заранее, второй раз двигать их не нужно.
    handle_drop_transition(...args) {
      if (skipDropTransition) {
        return undefined;
      }
      return originals.handle_drop_transition.call(this, ...args);
    },

    handle_dragend(event) {
      const result = originals.handle_dragend.call(this, event);
      guarded(() => clearGap(true));
      dragSize = 0;
      return result;
    },
  };

  // Вкладку утащили с панели на страницу: проекция в списке больше не нужна.
  function onWindowDragOver(event) {
    if (gap && !event.target.closest?.("#navigator-toolbox")) {
      guarded(() => clearGap(true));
    }
  }

  const prefObserver = { observe: () => guarded(syncSpaceRows) };

  function install() {
    dnd = gBrowser.tabContainer.tabDragAndDrop;
    for (const [name, wrapper] of Object.entries(wrappers)) {
      originals[name] = dnd[name];
      dnd[name] = wrapper;
    }
    window.addEventListener("dragover", onWindowDragOver, true);
    Services.prefs.addObserver(PREF_SPACE_ROW, prefObserver);
    syncSpaceRows();
  }

  function uninstall() {
    if (!dnd) {
      return;
    }
    guarded(() => clearGap(false));
    for (const name of Object.keys(wrappers)) {
      // Обёртки лежат собственными свойствами поверх методов класса.
      delete dnd[name];
    }
    window.removeEventListener("dragover", onWindowDragOver, true);
    Services.prefs.removeObserver(PREF_SPACE_ROW, prefObserver);
    for (const row of document.querySelectorAll(SPACE_ROW_SELECTOR)) {
      row.classList.add("zen-drop-target");
    }
    root.style.removeProperty("--zbm-gap-size");
    dnd = null;
  }

  // Скрипт может загрузиться раньше, чем Zen соберёт панель вкладок.
  let attempts = 0;
  function whenReady() {
    let ready = false;
    try {
      ready = !!(window.gBrowser?.tabContainer?.tabDragAndDrop && window.gZenWorkspaces?.activeWorkspaceElement);
    } catch {}
    if (ready) {
      guarded(install);
    } else if (attempts++ < 100) {
      setTimeout(whenReady, 200);
    }
  }
  whenReady();

  window.addUnloadListener?.(uninstall);
})();
