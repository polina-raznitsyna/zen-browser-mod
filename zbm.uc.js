/*
 * Живая перестановка вкладок при перетаскивании.
 *
 * Куда упадёт вкладка, по-прежнему решает Zen. Скрипт только показывает это
 * иначе: вместо линии-индикатора соседние вкладки расступаются, а на месте
 * будущей вкладки стоит её проекция. Проекция это псевдоэлемент контейнера,
 * поставленный в нужное место через order, поэтому раскладку считает сам
 * браузер: папка растёт под вкладку, сетка перестраивается.
 *
 * Работает для одной вкладки, которую переносят внутри панели. Перетаскивание
 * самих папок, важных вкладок, мультивыделения, копирование и разделение
 * экрана остаются на штатном индикаторе Zen. При любой ошибке скрипт убирает
 * своё и не мешает штатному перетаскиванию.
 *
 * Сверено с исходниками Zen 1.24.3b: ZenDragAndDrop.js.
 */
(() => {
  "use strict";

  const PREF_LIVE = "mod.zbm.dnd.live-reorder";
  const PREF_SPACE_ROW = "mod.zbm.dnd.space-row-no-drop";
  const PREF_FOLDER_INSIDE = "mod.zbm.dnd.folder-drop-inside";
  const PREF_NO_ESSENTIAL_LANDING = "mod.zbm.dnd.no-essential-landing";

  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const ROW_SELECTOR =
    ".tabbrowser-tab, .tab-group-label-container, .pinned-tabs-container-separator, #tabbrowser-arrowscrollbox-periphery";
  const SPACE_ROW_SELECTOR = ".zen-current-workspace-indicator";
  const MOVE_MS = 140;
  const MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";
  const FOLDER_OPEN_MS = 500;
  // Zen округляет координату линии, поэтому границы сравниваем с допуском.
  const EDGE_TOLERANCE = 2;

  const root = document.documentElement;
  const getPref = name => Services.prefs.getBoolPref(name, false);

  let dnd = null;
  let disposed = false;
  let readyTimer = null;
  // Аргументы последнего _placeDropIndicator за текущий dragover: признак
  // того, что Zen в этот момент показывает линию, и её координата.
  let pendingIndicator = null;
  // Текущая проекция. node и before задают её место, slot это её прямоугольник
  // в списке, dropElement и dropBefore это решение Zen, которому она отвечает.
  let gap = null;
  let dragSize = 0;
  let dropping = false;
  let hoverFolder = null;
  let hoverTimer = null;
  const running = new Map();

  const reduceMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const activeWorkspace = () => window.gZenWorkspaces?.activeWorkspaceElement;

  /** Все строки активного пространства: то, что может сдвигаться. */
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

  function cancelRunning() {
    for (const animation of running.values()) {
      animation.cancel();
    }
    running.clear();
  }

  /**
   * Доводит строки от старых мест к новым. Раскладка уже поменялась, поэтому
   * каждая строка стартует со смещением к прежнему месту и едет в ноль.
   * Раскладку анимация не трогает: Zen продолжает видеть строки на новых местах.
   */
  function glide(list, was) {
    cancelRunning();
    if (reduceMotion()) {
      return;
    }
    for (const el of list) {
      const from = was.get(el);
      const to = el.getBoundingClientRect();
      if (!from?.height || !to.height) {
        continue;
      }
      const dx = from.left - to.left;
      const dy = from.top - to.top;
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
      cancelRunning();
      return;
    }
    const list = animate ? rows() : [];
    const was = measure(list);
    removeGapAttributes();
    glide(list, was);
  }

  /** Прямоугольник проекции в списке. В сетке его не вычислить, там свой способ удержания. */
  function slotRect(target, container) {
    if (target.grid) {
      return null;
    }
    const box = container.getBoundingClientRect();
    const rect = target.node.getBoundingClientRect();
    const top = target.before ? rect.top - dragSize : rect.bottom;
    return { top, bottom: top + dragSize, left: box.left, right: box.right };
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
    const was = measure(list);
    cancelRunning();
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
    gap = {
      node: target.node,
      before: target.before,
      grid: !!target.grid,
      container,
      tagged,
      draggedTab,
      dropElement: draggedTab._dragData.dropElement,
      dropBefore: draggedTab._dragData.dropBefore,
    };
    gap.slot = slotRect(gap, container);

    glide(list, was);
  }

  const near = (a, b) => Math.abs(a - b) <= EDGE_TOLERANCE;

  const insideSlot = (event, slot) =>
    slot &&
    event.clientY >= slot.top &&
    event.clientY < slot.bottom &&
    event.clientX >= slot.left &&
    event.clientX < slot.right;

  /** Строка заголовка папки сама проекцию не держит: до неё и после свёрнутой папки место принадлежит папке. */
  function normalizeTarget(node, before) {
    if (node.classList.contains("tab-group-label-container")) {
      const folder = node.parentElement;
      if (before || folder.collapsed) {
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
    const element = data.dropElement;
    const before = !!data.dropBefore;

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
   * плитке под курсором: ближняя к началу строки половина ставит перед
   * плиткой, дальняя после.
   */
  function targetFromGrid(event, draggedTab) {
    const section = activeWorkspace()?.querySelector(".zen-workspace-pinned-tabs-section");
    if (!section?.contains(event.target)) {
      return null;
    }
    const style = getComputedStyle(section);
    if (style.display !== "grid") {
      return null;
    }
    const rtl = style.direction === "rtl";
    const tile = event.target.closest?.(".tabbrowser-tab");
    if (tile && tile !== draggedTab && tile.parentElement === section) {
      const rect = tile.getBoundingClientRect();
      const leftHalf = event.clientX < rect.left + rect.width / 2;
      return { node: tile, before: leftHalf !== rtl, grid: true };
    }
    if (event.target !== section) {
      return null;
    }
    // Курсор над самой проекцией: плитки под ним нет, место уже выбрано.
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
    return inRow.length ? { node: inRow.at(-1), before: false, grid: true } : null;
  }

  function cancelFolderHover() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverFolder = null;
  }

  /**
   * Курсор на заголовке папки, и Zen готов бросить вкладку в неё. Вместо
   * подсветки заголовка показываем проекцию первой строкой внутри папки:
   * именно туда Zen и положит вкладку. Свёрнутая папка сначала раскрывается,
   * если задержаться над ней.
   *
   * @returns {object|null|undefined} Место для проекции; null, пока ждём
   *   раскрытия папки; undefined, если курсор не на заголовке папки.
   */
  function targetFromFolderLabel(event) {
    const label = getPref(PREF_FOLDER_INSIDE)
      ? event.target.closest?.(".tab-group-label-container.zen-drop-target")
      : null;
    const folder = label?.parentElement;
    if (!folder?.isZenFolder || !document.getElementById("zen-dragover-background")) {
      cancelFolderHover();
      return undefined;
    }
    if (folder.collapsed) {
      if (hoverFolder !== folder) {
        cancelFolderHover();
        hoverFolder = folder;
        hoverTimer = setTimeout(() => {
          if (hoverFolder === folder && folder.isConnected) {
            folder.collapsed = false;
          }
          cancelFolderHover();
        }, FOLDER_OPEN_MS);
      }
      return null;
    }
    cancelFolderHover();
    return { node: label, before: false };
  }

  function canDragLive(event, draggedTab) {
    return (
      getPref(PREF_LIVE) &&
      dragSize > 0 &&
      root.getAttribute("zen-sidebar-expanded") === "true" &&
      draggedTab &&
      gBrowser.isTab(draggedTab) &&
      draggedTab.documentGlobal === window &&
      !draggedTab.hasAttribute("zen-essential") &&
      !draggedTab.group?.hasAttribute("split-view-group") &&
      draggedTab._dragData?.movingTabs?.length === 1 &&
      !draggedTab._dragData.fromTabList &&
      !dnd._splitDropReady &&
      dnd.getDropEffectForTabDrag(event) === "move"
    );
  }

  /** После того как Zen обработал dragover: показать, передвинуть или убрать проекцию. */
  function reconcile(event) {
    const indicator = pendingIndicator;
    pendingIndicator = null;
    const draggedTab = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!canDragLive(event, draggedTab)) {
      cancelFolderHover();
      clearGap(true);
      return;
    }
    const data = draggedTab._dragData;

    // Курсор внутри проекции: место уже выбрано, держим его. Иначе сдвиг
    // строк под неподвижным курсором заставлял бы цель прыгать.
    if (gap && insideSlot(event, gap.slot)) {
      data.dropElement = gap.dropElement;
      data.dropBefore = gap.dropBefore;
      return;
    }

    const gridTarget = targetFromGrid(event, draggedTab);
    if (gridTarget) {
      // Zen на каждом dragover пересчитывает цель по-своему, возвращаем нашу.
      data.dropElement = gridTarget.node;
      data.dropBefore = gridTarget.before;
      showGap(gridTarget, draggedTab);
      return;
    }

    const folderTarget = targetFromFolderLabel(event);
    if (folderTarget) {
      showGap(folderTarget, draggedTab);
      return;
    }
    if (folderTarget === null) {
      clearGap(true);
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
      // Линии нет: Zen подсвечивает цель целиком или цели нет вовсе.
      clearGap(true);
    }
  }

  function endDrag() {
    cancelFolderHover();
    removeGapAttributes();
    cancelRunning();
    pendingIndicator = null;
  }

  function guarded(step) {
    try {
      step();
    } catch (error) {
      console.error("[zen-browser-mod] live reorder failed:", error);
      try {
        endDrag();
      } catch {}
    }
  }

  /**
   * Строка пространства не подсвечивается как место для броска, пока включена
   * настройка. Бросок на неё Zen по-прежнему принимает: вкладка закрепится
   * и встанет туда, где стоит проекция.
   */
  function syncSpaceRows() {
    const off = getPref(PREF_SPACE_ROW);
    for (const row of document.querySelectorAll(SPACE_ROW_SELECTOR)) {
      row.classList.toggle("zen-drop-target", !off);
    }
  }

  const originals = {};
  const wrappers = {
    startTabDrag(event, tab, ...args) {
      // Прошлое перетаскивание могло оборваться без dragend.
      guarded(endDrag);
      const result = originals.startTabDrag.call(this, event, tab, ...args);
      guarded(() => {
        syncSpaceRows();
        dragSize = gBrowser.isTab(tab) ? tab.getBoundingClientRect().height : 0;
        // Изображение важной вкладки система доводит до места из неверной
        // точки. Переписать этот полёт мод не может, только не запускать его.
        if (getPref(PREF_NO_ESSENTIAL_LANDING) && tab.hasAttribute?.("zen-essential")) {
          this._dropLandingArmed = false;
          this.ZenDragAndDropService.armDropLanding(false);
        }
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

    // Проекция стоит до тех пор, пока Zen не перенёс вкладку: Firefox снимает
    // положения строк перед броском и после, и с проекцией они совпадают,
    // поэтому его собственная анимация перестановки не запускается второй раз.
    handle_drop(event) {
      dropping = !!gap;
      cancelFolderHover();
      try {
        return originals.handle_drop.call(this, event);
      } finally {
        dropping = false;
        guarded(endDrag);
      }
    },

    // Штатная анимация Zen раздвигает соседей уже после броска. С проекцией
    // они стоят на местах заранее.
    handle_drop_transition(...args) {
      if (dropping) {
        return undefined;
      }
      return originals.handle_drop_transition.call(this, ...args);
    },

    // Zen зовёт этот метод сразу после переноса вкладки и до того, как
    // посчитает, куда приземлить её изображение. Здесь проекция и уходит:
    // вкладка уже стоит на её месте.
    _handle_dropCreateSplit(...args) {
      if (dropping) {
        guarded(endDrag);
      }
      return originals._handle_dropCreateSplit.call(this, ...args);
    },

    handle_dragend(event) {
      try {
        return originals.handle_dragend.call(this, event);
      } finally {
        cancelFolderHover();
        guarded(() => clearGap(true));
        dragSize = 0;
      }
    },
  };

  // Вкладку утащили с панели на страницу: проекция в списке больше не нужна.
  function onWindowDragOver(event) {
    if ((gap || hoverTimer) && !event.target.closest?.("#navigator-toolbox")) {
      cancelFolderHover();
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
    disposed = true;
    clearTimeout(readyTimer);
    if (!dnd) {
      return;
    }
    guarded(endDrag);
    for (const [name, wrapper] of Object.entries(wrappers)) {
      // Обёртки лежат собственными свойствами поверх методов класса.
      if (Object.hasOwn(dnd, name) && dnd[name] === wrapper) {
        delete dnd[name];
      }
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
    if (disposed) {
      return;
    }
    let ready = false;
    try {
      ready = !!(
        window.gBrowser?.tabContainer?.tabDragAndDrop &&
        window.gZenWorkspaces?.activeWorkspaceElement
      );
    } catch {}
    if (ready) {
      try {
        install();
      } catch (error) {
        console.error("[zen-browser-mod] live reorder failed to start:", error);
        uninstall();
      }
    } else if (attempts++ < 100) {
      readyTimer = setTimeout(whenReady, 200);
    }
  }
  whenReady();

  window.addUnloadListener?.(uninstall);
})();
