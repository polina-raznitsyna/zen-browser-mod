/*
 * Живая перестановка вкладок при перетаскивании.
 *
 * Пока вкладку несут над списком активного пространства, место для неё
 * выбирает этот скрипт, а не Zen: верхняя половина строки ставит вкладку
 * перед ней, нижняя после, у плиток так же по левой и правой половине.
 * Соседи расступаются, на выбранном месте стоит проекция. Проекция это
 * псевдоэлемент контейнера, поставленный в нужное место через order, поэтому
 * раскладку считает сам браузер: папка растёт под вкладку, сетка
 * перестраивается.
 *
 * Zen в это время свою линию не рисует и цель не пересчитывает: скрипт
 * перехватывает его _animateTabMove. Раньше скрипт подстраивался под решение
 * Zen, а Zen пересчитывал цель по уже сдвинутым строкам, и они раскачивали
 * друг друга. При броске Zen получает готовую цель в _dragData и переносит
 * вкладку сам.
 *
 * Если zbm-pins.uc.js вынес плитки закреплённых над прокруткой (секция
 * помечена zbm-split), вкладка верхнего уровня в закреплённых всегда встаёт
 * в сетку плиток, а папки на вид стоят ниже сетки. Поэтому место верхнего
 * уровня там сводится к плитке, перед которой встанет вкладка, а проекцию
 * рисует обёртка плиток.
 *
 * Работает для одной вкладки, которую переносят внутри панели. Перетаскивание
 * самих папок, мультивыделения, сетка важных вкладок, копирование и разделение
 * экрана остаются на штатной логике Zen. При любой ошибке скрипт убирает своё
 * и отдаёт перетаскивание Zen.
 *
 * Отдельной настройкой здесь же выключается разделение экрана, которое Zen
 * предлагает, если задержать вкладку над другой вкладкой.
 *
 * Ещё одна настройка прокручивает список, когда вкладку или папку подносят
 * к его краю. У Zen такой прокрутки нет: Firefox прокручивает полосу вкладок
 * только над кнопками-стрелками, а Zen их скрывает.
 *
 * Сверено с исходниками Zen 1.24.3b: ZenDragAndDrop.js, ZenPinnedTabManager.mjs
 * и drag-and-drop.js из Firefox 160.
 */
(() => {
  "use strict";

  const PREF_LIVE = "mod.zbm.dnd.live-reorder";
  const PREF_SPACE_ROW = "mod.zbm.dnd.space-row-no-drop";
  const PREF_FOLDER_OPEN = "mod.zbm.dnd.folder-drop-inside";
  const PREF_NO_ESSENTIAL_LANDING = "mod.zbm.dnd.no-essential-landing";
  const PREF_GHOST = "mod.zbm.dnd.ghost-follows-slot";
  const PREF_NO_SPLIT = "mod.zbm.dnd.no-split-on-tab";
  const PREF_EDGE_SCROLL = "mod.zbm.dnd.edge-scroll";

  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const MOVABLE_SELECTOR =
    ".tabbrowser-tab, .tab-group-label-container, .pinned-tabs-container-separator, #tabbrowser-arrowscrollbox-periphery";
  const SPACE_ROW_SELECTOR = ".zen-current-workspace-indicator";
  const MOVE_MS = 140;
  const MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";
  // Сколько держать вкладку над свёрнутой папкой, чтобы та раскрылась.
  const FOLDER_OPEN_MS = 350;
  // Zen раскрывает папку анимацией около 200 мс, строки в это время едут.
  const FOLDER_SETTLE_MS = 260;
  // Средняя часть заголовка свёрнутой папки не двигает проекцию, а ждёт раскрытия.
  const FOLDER_HOLD_FROM = 0.3;
  const FOLDER_HOLD_TO = 0.7;
  // Ответ pick: вкладку держат над свёрнутой папкой, проекции в этой зоне ещё нет.
  const HOLD = Symbol("hold");
  const LAYOUT_TTL_MS = 500;
  // Прокрутка у края списка: высота зоны, задержка перед стартом и скорость
  // от границы зоны до самого края, в пикселях в секунду.
  const EDGE_ZONE = 44;
  const EDGE_DELAY_MS = 250;
  const EDGE_SPEED_MIN = 150;
  const EDGE_SPEED_MAX = 1100;

  const root = document.documentElement;
  const getPref = name => Services.prefs.getBoolPref(name, false);

  let dnd = null;
  let disposed = false;
  let readyTimer = null;
  // Текущее перетаскивание: вкладка, её исходный вид и состояние картинки под курсором.
  let drag = null;
  // Текущая проекция: container и next задают её место, drop это цель для Zen.
  let gap = null;
  // Снимок строк зоны под курсором. Между сдвигами проекции раскладка не
  // меняется, поэтому dragover работает по снимку и не трогает раскладку.
  let layout = null;
  let hover = null;
  // Папка, раскрытая наведением: пока курсор на её заголовке, проекция стоит внутри.
  let openedFolder = null;
  let settleTimer = null;
  let holdUntil = 0;
  let dropping = false;
  const running = new Map();
  // Идёт ли перетаскивание, начатое в этой панели: вкладки или папки.
  let dragActive = false;
  // Прокрутка у края списка: что прокручиваем, с какой скоростью и с какого момента.
  let edge = null;
  let edgeFrame = 0;

  const reduceMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const activeWorkspace = () => window.gZenWorkspaces?.activeWorkspaceElement;

  // ---------------------------------------------------------------- анимация

  /** Всё, что может сдвинуться в активном пространстве, кроме самой перетаскиваемой вкладки. */
  function movable(workspace) {
    return [...workspace.querySelectorAll(MOVABLE_SELECTOR)].filter(
      // Вкладка внутри вкладки это glance, она едет вместе с родителем.
      el => el !== drag?.tab && !el.parentElement.closest(".tabbrowser-tab")
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
   */
  function glide(list, was) {
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

  // ------------------------------------------------------------ места в списке

  const isFolder = el => !!el?.isZenFolder;
  const isSplit = el => !!el?.hasAttribute?.("split-view-group");
  const isPlainTab = el =>
    gBrowser.isTab(el) && !el.hidden && !el.hasAttribute("zen-empty-tab");

  /** Элемент, рядом с которым Zen умеет ставить вкладку: вкладка, папка или разделённые вкладки. */
  const isAnchor = (el, tab) =>
    el !== tab && (isPlainTab(el) || isFolder(el) || isSplit(el));

  const labelOf = folder =>
    folder.querySelector(":scope > .tab-group-label-container");

  /** Следующий сосед, не считая перетаскиваемой вкладки и скрытых заглушек Zen. */
  function nextFlow(el, tab) {
    let next = el.nextElementSibling;
    while (next && (next === tab || next.hasAttribute("zen-empty-tab"))) {
      next = next.nextElementSibling;
    }
    return next;
  }

  function firstFlow(container, tab) {
    for (const child of container.children) {
      if (
        child !== tab &&
        !child.classList.contains("zen-tab-group-start") &&
        !child.hasAttribute("zen-empty-tab")
      ) {
        return child;
      }
    }
    return null;
  }

  /** Место перед строкой. Перед заголовком раскрытой папки это место перед самой папкой. */
  function posBefore(row) {
    const el = row.kind === "label" ? row.folder : row.el;
    return { container: el.parentElement, next: el };
  }

  /** Место после строки. После заголовка раскрытой папки это первая строка внутри неё. */
  function posAfter(row, tab) {
    if (row.kind === "label") {
      const container = row.folder.groupContainer;
      return { container, next: firstFlow(container, tab) };
    }
    return { container: row.el.parentElement, next: nextFlow(row.el, tab) };
  }

  /** Место в конце секции, после последней вкладки или папки. */
  function endPos(section, tab) {
    for (let el = section.lastElementChild; el; el = el.previousElementSibling) {
      if (isAnchor(el, tab)) {
        return { container: section, next: nextFlow(el, tab) };
      }
    }
    return null;
  }

  /** Секция закреплённых, где плитки вынесены над прокруткой. */
  const isSplitSection = section => !!section?.hasAttribute?.("zbm-split");

  /**
   * В секции с вынесенными плитками папки между плитками на вид не стоят,
   * поэтому разные места в документе дают одно и то же место в сетке. Место
   * сводится к плитке, перед которой встанет вкладка, или к концу сетки.
   */
  function normalize(pos, tab) {
    if (!pos || !isSplitSection(pos.container)) {
      return pos;
    }
    let next = pos.next;
    while (next && (next === tab || !isPlainTab(next))) {
      next = next.nextElementSibling;
    }
    if (!next) {
      // Конец сетки это место сразу за последней плиткой, а не конец секции:
      // иначе вкладка перескочила бы в документе через папки, стоящие следом.
      let last = null;
      for (const child of pos.container.children) {
        if (child !== tab && isPlainTab(child)) {
          last = child;
        }
      }
      next = last ? nextFlow(last, tab) : firstFlow(pos.container, tab);
    }
    return { container: pos.container, next };
  }

  /** Плитки и список меняют высоту места над прокруткой: просим обновить её сразу. */
  const syncTiles = workspace => workspace?.pinnedTabsContainer?._zbmSyncTiles?.();

  /** Место, где перетаскиваемая вкладка стоит сейчас, если проекцию там можно показать. */
  function homePos(tab, zone) {
    const container = tab.parentElement;
    if (!container || !zone.section.contains(container)) {
      return null;
    }
    if (container !== zone.section) {
      const folder = container.parentElement;
      const ok =
        container.classList.contains("tab-group-container") &&
        isFolder(folder) &&
        !folder.collapsed &&
        !folder.isLiveFolder;
      if (!ok) {
        return null;
      }
    }
    return { container, next: nextFlow(tab, tab) };
  }

  /**
   * Переводит место проекции в цель, которую понимает Zen: элемент и сторона,
   * с которой от него встанет вкладка.
   */
  function dropFor(pos, tab, section) {
    if (pos.next && isAnchor(pos.next, tab)) {
      return { element: pos.next, before: true };
    }
    let prev = pos.next
      ? pos.next.previousElementSibling
      : pos.container.lastElementChild;
    while (prev && !isAnchor(prev, tab)) {
      prev = prev.previousElementSibling;
    }
    if (prev) {
      return { element: prev, before: false };
    }
    // В контейнере нет ни одной видимой строки.
    const folder = pos.container.parentElement;
    if (pos.container !== section && isFolder(folder)) {
      // В пустой папке Zen держит скрытую вкладку-заглушку, встаём перед ней.
      const first = folder.tabs?.find(item => item !== tab);
      if (first) {
        return { element: first, before: true };
      }
      if (tab.group === folder) {
        // Единственная вкладка папки возвращается на своё место: переносить нечего.
        return { element: undefined, before: undefined };
      }
    }
    let next = pos.next;
    while (next && !isAnchor(next, tab)) {
      next = next.nextElementSibling;
    }
    return next ? { element: next, before: true } : null;
  }

  // ------------------------------------------------------------ снимок раскладки

  function scrollsOf(workspace) {
    return [
      workspace.pinnedTabsContainer?.scrollTop ?? 0,
      workspace.tabsContainer?.scrollTop ?? 0,
      // Сам arrowscrollbox не прокручивается, прокручивается его внутренняя часть.
      workspace.scrollbox?.scrollbox?.scrollTop ?? 0,
    ];
  }

  /**
   * Строки зоны в порядке сверху вниз с их прямоугольниками. Раскрытая папка
   * даёт строку заголовка и строки содержимого, свёрнутая идёт одной строкой.
   */
  function buildLayout(zone, tab) {
    const rows = [];
    const style = getComputedStyle(zone.section);
    const grid = zone.pinned && style.display === "grid";
    const split = zone.pinned && isSplitSection(zone.section);
    // Верхний край прокрутки: выше него видны только плитки, строки там обрезаны.
    const scroller = split ? zone.ws.scrollbox?.scrollbox : null;
    const push = (el, kind, extra) => {
      const rect = el.getBoundingClientRect();
      if (!rect.height || !rect.width) {
        return null;
      }
      const row = {
        el,
        kind,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        ...extra,
      };
      rows.push(row);
      return row;
    };
    const walk = (container, topLevel) => {
      for (const child of container.children) {
        if (child === tab) {
          continue;
        }
        if (gBrowser.isTab(child)) {
          if (isPlainTab(child)) {
            push(child, "tab", { tile: topLevel && grid });
          }
        } else if (isFolder(child)) {
          const label = labelOf(child);
          const inner = child.groupContainer;
          if (child.collapsed || child.isLiveFolder || !label || !inner) {
            // В живую папку Zen чужие вкладки не принимает, раскрывать её незачем.
            const openable = child.collapsed && !child.isLiveFolder && label;
            const labelRect = openable ? label.getBoundingClientRect() : null;
            push(child, "block", {
              folder: openable ? child : null,
              labelTop: labelRect?.top,
              labelBottom: labelRect?.bottom,
            });
          } else if (push(label, "label", { folder: child })) {
            walk(inner, false);
          }
        } else if (isSplit(child)) {
          push(child, "block", {});
        }
      }
    };
    walk(zone.section, true);

    const sizeOf = row => row && { w: row.right - row.left, h: row.bottom - row.top };
    return {
      ws: zone.ws,
      pinned: zone.pinned,
      tab,
      rows,
      grid,
      split,
      clipTop: scroller ? scroller.getBoundingClientRect().top : -Infinity,
      rtl: style.direction === "rtl",
      top: rows.length ? Math.min(...rows.map(row => row.top)) : 0,
      bottom: rows.length ? Math.max(...rows.map(row => row.bottom)) : 0,
      tileSize: sizeOf(rows.find(row => row.tile)),
      rowSize: sizeOf(rows.find(row => row.kind === "tab" && !row.tile)),
      scrolls: scrollsOf(zone.ws),
      time: performance.now(),
    };
  }

  function getLayout(zone, tab) {
    const current = layout;
    if (
      current &&
      current.ws === zone.ws &&
      current.pinned === zone.pinned &&
      current.tab === tab
    ) {
      const scrolls = scrollsOf(zone.ws);
      const scrolled = scrolls.some((value, i) => value !== current.scrolls[i]);
      // Пока строки доезжают, их прямоугольники сдвинуты анимацией, а снимок
      // хранит конечные места. Поэтому посреди анимации его не обновляем.
      if (!scrolled && (running.size || performance.now() - current.time < LAYOUT_TTL_MS)) {
        return current;
      }
    }
    // Снимать можно только стоящие строки: недоехавшие ставим на места сразу.
    cancelRunning();
    layout = buildLayout(zone, tab);
    return layout;
  }

  // ------------------------------------------------------------------ проекция

  function removeGapAttributes() {
    if (!gap) {
      return;
    }
    gap.container.removeAttribute("zbm-gap");
    for (const el of gap.tagged) {
      el.removeAttribute("zbm-after");
    }
    gap.tab.removeAttribute("zbm-dragging");
    root.removeAttribute("zbm-live-dnd");
    gap = null;
  }

  function clearGap(animate) {
    if (!gap) {
      cancelRunning();
      return;
    }
    const workspace = gap.ws;
    const list = animate && workspace.isConnected ? movable(workspace) : [];
    const was = measure(list);
    cancelRunning();
    removeGapAttributes();
    syncTiles(workspace);
    layout = null;
    glide(list, was);
  }

  const samePos = (a, b) => a.container === b.container && a.next === b.next;

  function haptic() {
    try {
      // eslint-disable-next-line mozilla/valid-services
      Services.zen?.playHapticFeedback?.();
    } catch {}
  }

  /**
   * Ставит проекцию в pos. Все соседи после неё получают order: 1, как и сама
   * проекция, поэтому она встаёт ровно между ними и предыдущими. Соседей со
   * своим order (кнопка новой вкладки) не трогаем.
   *
   * @returns {boolean} Стоит ли проекция в pos после вызова.
   */
  function showGap(pos, zone, tab, { quiet = false } = {}) {
    if (gap && samePos(gap, pos)) {
      return true;
    }
    const drop = dropFor(pos, tab, zone.section);
    if (!drop || !pos.container?.isConnected) {
      return false;
    }
    const list = movable(zone.ws);
    const was = measure(list);
    cancelRunning();
    removeGapAttributes();

    // Высота проекции в списке равна высоте строки. Её надо задать до того,
    // как снимать раскладку с проекцией.
    const knownHeight = layout?.rowSize?.h ?? (drag.row ? drag.height : 0);
    if (knownHeight) {
      root.style.setProperty("--zbm-gap-size", `${knownHeight}px`);
    }

    const tagged = [];
    for (let sibling = pos.next; sibling; sibling = sibling.nextElementSibling) {
      if (isAnchor(sibling, null) || getComputedStyle(sibling).order === "0") {
        sibling.setAttribute("zbm-after", "");
        tagged.push(sibling);
      }
    }
    pos.container.setAttribute("zbm-gap", "");
    // Важная вкладка остаётся в своей сетке: Zen сам прячет её на время
    // перетаскивания, а её ячейка держит высоту панели.
    if (!tab.hasAttribute("zen-essential")) {
      tab.setAttribute("zbm-dragging", "");
    }
    root.setAttribute("zbm-live-dnd", "");
    gap = {
      container: pos.container,
      next: pos.next,
      tagged,
      tab,
      ws: zone.ws,
      pinned: zone.pinned,
      drop,
    };
    tab._dragData.dropElement = drop.element;
    tab._dragData.dropBefore = drop.before;
    drag.armed = true;

    syncTiles(zone.ws);
    layout = buildLayout(zone, tab);
    const rowHeight = layout.rowSize?.h;
    if (rowHeight && rowHeight !== knownHeight) {
      root.style.setProperty("--zbm-gap-size", `${rowHeight}px`);
      layout = buildLayout(zone, tab);
    }
    glide(list, was);
    if (!quiet) {
      haptic();
    }
    return true;
  }

  // --------------------------------------------------- картинка под курсором

  function imageParts() {
    const wrapper = dnd?.originalDragImageArgs?.[0];
    const clone = wrapper?.firstElementChild;
    return wrapper && clone ? { wrapper, clone } : null;
  }

  /**
   * Картинка под курсором принимает вид места, над которым её несут: плитка
   * над сеткой закреплённых, строка над списком. Картинку Zen делает из копии
   * вкладки и отдаёт системе, здесь копия меняет вид и отдаётся заново.
   */
  function setImageForm(event, tile) {
    if (!drag?.image || drag.image.form === tile || !getPref(PREF_GHOST)) {
      return;
    }
    const parts = imageParts();
    const own = { w: drag.width, h: drag.height };
    const size = tile
      ? (layout?.tileSize ?? (drag.tile ? own : null))
      : (layout?.rowSize ?? (drag.row ? own : null));
    if (!parts || !size) {
      return;
    }
    const { wrapper, clone } = parts;
    drag.image.form = tile;
    clone.toggleAttribute("zbm-tile", tile);
    wrapper.style.width = `${size.w}px`;
    wrapper.style.height = `${size.h}px`;
    if (!tile && clone.textLabel) {
      // Подпись у копии обрезана под ширину на момент захвата, у плитки это пара букв.
      clone.textLabel.textContent = drag.tab.label.slice(0, Math.floor(size.w / 6));
    }
    const [offsetX, offsetY] =
      tile === drag.image.startTile
        ? drag.image.offsets
        : [tile ? size.w / 2 : Math.min(size.w / 2, 60), size.h / 2];
    dnd.originalDragImageArgs = [wrapper, offsetX, offsetY];
    dnd._refreshDragImage(event.dataTransfer);
  }

  // ------------------------------------------------------------ свёрнутые папки

  function cancelHover() {
    if (!hover) {
      return;
    }
    clearTimeout(hover.timer);
    hover.folder.removeAttribute("zbm-drop-hover");
    hover = null;
  }

  /** Вкладку держат над заголовком свёрнутой папки: подсвечиваем его и раскрываем папку. */
  function startHover(folder, zone) {
    if (hover?.folder === folder) {
      return;
    }
    cancelHover();
    folder.setAttribute("zbm-drop-hover", "");
    hover = {
      folder,
      timer: setTimeout(() => guarded(() => openHovered(folder, zone)), FOLDER_OPEN_MS),
    };
  }

  function openHovered(folder, zone) {
    cancelHover();
    if (!drag?.owned || !folder.isConnected || !folder.collapsed) {
      return;
    }
    folder.collapsed = false;
    openedFolder = folder;
    layout = null;
    holdUntil = performance.now() + FOLDER_SETTLE_MS;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(
      () =>
        guarded(() => {
          const tab = drag?.tab;
          const inner = folder.groupContainer;
          const stillThere =
            drag?.owned &&
            tab &&
            inner &&
            openedFolder === folder &&
            !folder.collapsed &&
            zone.ws === activeWorkspace() &&
            zone.ws.contains(folder);
          if (!stillThere) {
            return;
          }
          layout = null;
          showGap({ container: inner, next: firstFlow(inner, tab) }, zone, tab);
        }),
      FOLDER_SETTLE_MS
    );
  }

  // -------------------------------------------------------------- выбор места

  /** Над какой частью панели курсор. Так же зону определяет Zen, когда решает, закреплять ли вкладку при броске. */
  function zoneOf(event) {
    const ws = activeWorkspace();
    const target = event.target;
    if (!ws || !target?.closest || !ws.contains(target)) {
      return null;
    }
    const hit = target.closest(
      ".zen-current-workspace-indicator, .zen-workspace-pinned-tabs-section"
    );
    const pinned = !!hit;
    if (pinned && ws.hasCollapsedPinnedTabs) {
      return null;
    }
    const section = pinned ? ws.pinnedTabsContainer : ws.tabsContainer;
    if (!section) {
      return null;
    }
    return {
      ws,
      pinned,
      section,
      indicator: pinned && hit.classList.contains("zen-current-workspace-indicator"),
    };
  }

  function canDragLive(tab) {
    return (
      getPref(PREF_LIVE) &&
      !!drag &&
      drag.tab === tab &&
      root.getAttribute("zen-sidebar-expanded") === "true" &&
      !root.hasAttribute("customizing") &&
      gBrowser.isTab(tab) &&
      tab.documentGlobal === window &&
      !tab.hasAttribute("zen-glance-tab") &&
      !tab.hasAttribute("zen-live-folder-item-id") &&
      !tab.group?.hasAttribute("split-view-group") &&
      tab._dragData?.movingTabs?.length === 1 &&
      !dnd._splitDropReady
    );
  }

  function nearest(rows, y) {
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      const distance = y < row.top ? row.top - y : y >= row.bottom ? y - row.bottom : 0;
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Место для проекции под курсором, null, если её не надо двигать, или HOLD.
   *
   * Строка под курсором сама задаёт место своей половиной. Это правило
   * устойчиво: после сдвига курсор оказывается либо над проекцией, либо над
   * той же половиной той же строки, и повторного сдвига нет.
   */
  function pick(event, zone, L, hasGap, tab) {
    const x = event.clientX;
    const y = event.clientY;
    const rows = L.rows;
    if (zone.indicator) {
      cancelHover();
      return posBefore(rows[0]);
    }

    // Над вынесенными плитками строки списка есть, но обрезаны прокруткой:
    // там считаются только плитки, ниже только строки.
    const overTiles = L.split && y < L.clipTop;
    const row = rows.find(
      item =>
        y >= item.top &&
        y < item.bottom &&
        (!item.tile || (x >= item.left && x < item.right)) &&
        (!L.split || !!item.tile === overTiles)
    );
    if (row?.folder !== openedFolder || row.kind !== "label") {
      openedFolder = null;
    }
    if (row) {
      if (openedFolder) {
        // Папку только что раскрыли наведением: вкладку несут в неё, а не мимо.
        return posAfter(row, tab);
      }
      if (row.tile) {
        cancelHover();
        const nearStart = x < (row.left + row.right) / 2 !== L.rtl;
        return nearStart ? posBefore(row) : posAfter(row, tab);
      }
      if (row.folder && row.kind === "block" && y >= row.labelTop && y < row.labelBottom) {
        const part = (y - row.labelTop) / (row.labelBottom - row.labelTop);
        if (part >= FOLDER_HOLD_FROM && part <= FOLDER_HOLD_TO && getPref(PREF_FOLDER_OPEN)) {
          startHover(row.folder, zone);
          // Без проекции в этой зоне ставить её пока некуда: она сдвинула бы
          // папку из-под курсора. Ждём раскрытия.
          return hasGap ? null : HOLD;
        }
        cancelHover();
        return part < 0.5 ? posBefore(row) : posAfter(row, tab);
      }
      cancelHover();
      return y < (row.top + row.bottom) / 2 ? posBefore(row) : posAfter(row, tab);
    }

    cancelHover();
    if (!L.split) {
      if (y < L.top) {
        return posBefore(rows[0]);
      }
      if (y >= L.bottom) {
        // Курсор над проекцией в конце папки: она уже стоит ниже всех строк.
        if (hasGap && gap.container !== zone.section && event.target === gap.container) {
          return null;
        }
        return endPos(zone.section, tab) ?? (hasGap ? null : posAfter(rows.at(-1), tab));
      }
    }
    if (L.grid && (!L.split || overTiles)) {
      // Курсор в пустом хвосте ряда плиток: место после последней плитки ряда.
      const line = rows.filter(item => item.tile && y >= item.top && y < item.bottom);
      if (line.length) {
        const last = line.reduce((a, b) =>
          (L.rtl ? b.left < a.left : b.right > a.right) ? b : a
        );
        if (L.rtl ? x < last.left : x >= last.right) {
          return posAfter(last, tab);
        }
      }
    }
    if (hasGap) {
      if (overTiles && gap.container !== zone.section) {
        // Курсор поднялся к плиткам, а проекция осталась в папке ниже.
        return endPos(zone.section, tab);
      }
      // Курсор над самой проекцией или в зазоре между строками.
      return null;
    }
    if (L.split) {
      // Вкладку внесли в закреплённые мимо строк: она встанет последней плиткой.
      return endPos(zone.section, tab);
    }
    const closest = nearest(rows, y);
    return y < (closest.top + closest.bottom) / 2 ? posBefore(closest) : posAfter(closest, tab);
  }

  /**
   * Первый dragover над списком после сетки важных или начала перетаскивания.
   * Штатный обработчик Zen вызывается так, чтобы он вышел сразу после своей
   * первой части: она возвращает картинке под курсором обычный вид, если та
   * успела стать плиткой важной вкладки. Остальное из его уборки повторено здесь.
   */
  function takeOver(event, tab) {
    if (drag.owned) {
      return;
    }
    drag.owned = true;
    tab._dragData.animLastScreenPos = event.screenY;
    originals._animateTabMove.call(dnd, event);

    const fake = dnd._fakeEssentialTab;
    if (fake) {
      fake.remove();
      delete dnd._fakeEssentialTab;
      const essentials = gBrowser.tabContainer.visibleTabs.slice(0, gBrowser._numZenEssentials);
      for (const essential of essentials) {
        essential.style.transform = "";
      }
      gZenWorkspaces.updateTabsContainers();
    }
    dnd.clearDragOverVisuals({ clearSplitDropIndicator: false });
    window.gZenFolders?.highlightGroupOnDragOver(null);
    layout = null;
  }

  /**
   * Забирает у Zen цель, которую ставил мод. Без этого Zen при броске перенёс
   * бы вкладку к месту проекции, которой уже нет.
   */
  function disarm() {
    const data = drag?.tab?._dragData;
    if (!drag?.armed || !data) {
      return;
    }
    drag.armed = false;
    data.dropElement = undefined;
    data.dropBefore = undefined;
    // Чтобы штатный обработчик Zen пересчитал цель с первого же события.
    delete data.animLastScreenPos;
    delete data.animDropElementIndex;
  }

  /** Отдаёт перетаскивание штатной логике Zen. */
  function release() {
    disarm();
    if (drag) {
      drag.owned = false;
    }
    cancelHover();
    clearTimeout(settleTimer);
    openedFolder = null;
    clearGap(true);
    layout = null;
  }

  /** @returns {boolean} true, если dragover обработан здесь и штатный обработчик Zen звать не надо. */
  function liveMove(event) {
    const tab = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    const zone = canDragLive(tab) ? zoneOf(event) : null;
    if (!zone) {
      if (drag && event.target?.closest?.("#zen-essentials")) {
        // Над сеткой важных Zen сам меняет вид картинки.
        drag.image.form = null;
      }
      release();
      return false;
    }
    takeOver(event, tab);
    if (performance.now() < holdUntil) {
      if (openedFolder?.contains(event.target)) {
        // Папка раскрывается, строки ещё едут: ждём.
        return true;
      }
      // Курсор ушёл с папки, не дождавшись: проекция в неё уже не пойдёт.
      holdUntil = 0;
      openedFolder = null;
      clearTimeout(settleTimer);
      layout = null;
    }

    let hasGap = !!gap && gap.ws === zone.ws && gap.pinned === zone.pinned;
    const L = getLayout(zone, tab);
    if (!drag.started) {
      // Начало перетаскивания: проекция встаёт на место самой вкладки, ничего не сдвигая.
      drag.started = true;
      const home = hasGap ? null : normalize(homePos(tab, zone), tab);
      if (home && showGap(home, zone, tab, { quiet: true })) {
        setImageForm(event, layout.grid && home.container === zone.section);
        return true;
      }
    }
    if (!L.rows.length) {
      // В зоне не к чему пристроиться: пустую секцию Zen обрабатывает сам.
      if (hasGap) {
        return true;
      }
      release();
      return false;
    }

    const picked = pick(event, zone, L, hasGap, tab);
    if (picked === HOLD) {
      return true;
    }
    const pos = normalize(picked, tab);
    if (pos) {
      showGap(pos, zone, tab, { quiet: edgeScrolling() });
    }
    hasGap = !!gap && gap.ws === zone.ws && gap.pinned === zone.pinned;
    if (!hasGap) {
      release();
      return false;
    }
    setImageForm(event, !!layout?.grid && gap.container === zone.section);
    return true;
  }

  function endDrag() {
    cancelHover();
    clearTimeout(settleTimer);
    holdUntil = 0;
    openedFolder = null;
    removeGapAttributes();
    cancelRunning();
    layout = null;
    if (drag) {
      drag.owned = false;
    }
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

  // ------------------------------------------------------- прокрутка у края

  /** Идёт ли ещё перетаскивание: система может закончить его, не прислав сюда событий. */
  function dragSessionActive() {
    try {
      const service = Cc["@mozilla.org/widget/dragservice;1"].getService(Ci.nsIDragService);
      return !!service.getCurrentSession(window);
    } catch {
      return dragActive;
    }
  }

  function stopEdgeScroll() {
    edge = null;
    cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
  }

  /** Список уже едет: проекция в это время переставляется без отдачи трекпада. */
  const edgeScrolling = () =>
    !!edge && performance.now() - edge.since >= EDGE_DELAY_MS;

  function edgeTick(now) {
    edgeFrame = 0;
    if (!edge || !dragActive || !edge.el.isConnected || !dragSessionActive()) {
      stopEdgeScroll();
      return;
    }
    const elapsed = Math.min(now - edge.last, 50);
    edge.last = now;
    if (now - edge.since >= EDGE_DELAY_MS) {
      edge.el.scrollBy({ top: (edge.speed * elapsed) / 1000, behavior: "instant" });
    }
    edgeFrame = requestAnimationFrame(edgeTick);
  }

  /**
   * Прокручиваемая часть списка под курсором и скорость, с которой её надо
   * вести. Прокручиваться может scrollbox внутри arrowscrollbox, как у Zen,
   * или сами секции, если закреплённые стоят на месте.
   */
  function edgeTarget(event) {
    const ws = activeWorkspace();
    if (!ws || !event.target?.closest?.("#navigator-toolbox")) {
      return null;
    }
    const x = event.clientX;
    const y = event.clientY;
    for (const el of [ws.scrollbox?.scrollbox, ws.pinnedTabsContainer, ws.tabsContainer]) {
      if (!el || !(el.scrollTopMax > 0)) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
        continue;
      }
      const fromTop = y - rect.top;
      const fromBottom = rect.bottom - y;
      const speedAt = distance =>
        EDGE_SPEED_MIN + (EDGE_SPEED_MAX - EDGE_SPEED_MIN) * (1 - distance / EDGE_ZONE);
      if (fromTop < EDGE_ZONE && el.scrollTop > 0) {
        return { el, speed: -speedAt(fromTop) };
      }
      if (fromBottom < EDGE_ZONE && el.scrollTop < el.scrollTopMax) {
        return { el, speed: speedAt(fromBottom) };
      }
      return null;
    }
    return null;
  }

  /**
   * Вызывается на каждый dragover. Прокрутка стартует, если курсор задержался
   * в зоне у края: вкладку, которую просто проносят мимо, список не уводит.
   */
  function updateEdgeScroll(event) {
    const target = dragActive && getPref(PREF_EDGE_SCROLL) ? edgeTarget(event) : null;
    if (!target) {
      stopEdgeScroll();
      return;
    }
    const sameRun = edge && edge.el === target.el && edge.speed < 0 === target.speed < 0;
    if (sameRun) {
      edge.speed = target.speed;
    } else {
      const now = performance.now();
      edge = { ...target, since: now, last: now };
    }
    if (!edgeFrame) {
      edgeFrame = requestAnimationFrame(edgeTick);
    }
  }

  /**
   * Строка пространства не подсвечивается как место для броска, пока включена
   * настройка. Бросок на неё Zen по-прежнему принимает: вкладка закрепится
   * и встанет первой, туда же, где стоит проекция.
   */
  function syncSpaceRows() {
    const off = getPref(PREF_SPACE_ROW);
    for (const row of document.querySelectorAll(SPACE_ROW_SELECTOR)) {
      row.classList.toggle("zen-drop-target", !off);
    }
  }

  const isTile = tab => {
    const section = tab.parentElement;
    return (
      !!section?.classList.contains("zen-workspace-pinned-tabs-section") &&
      getComputedStyle(section).display === "grid"
    );
  };

  /** После броска Firefox доводит строки от старых мест к новым. С проекцией они уже стоят где надо. */
  function stopFirefoxDropAnimation() {
    const items = [...document.querySelectorAll("[tabdrop-samewindow]")];
    for (const el of items) {
      // Даём переходу начаться, чтобы его отмена дошла до обработчиков
      // Firefox и те убрали за собой.
      getComputedStyle(el).transform;
    }
    for (const el of items) {
      el.removeAttribute("tabdrop-samewindow");
    }
  }

  const originals = {};
  const wrappers = {
    startTabDrag(event, tab, ...args) {
      // Прошлое перетаскивание могло оборваться без dragend.
      guarded(endDrag);
      drag = null;
      stopEdgeScroll();
      dragActive = true;
      const result = originals.startTabDrag.call(this, event, tab, ...args);
      guarded(() => {
        syncSpaceRows();
        if (!gBrowser.isTab(tab)) {
          return;
        }
        const rect = tab.getBoundingClientRect();
        const essential = tab.hasAttribute("zen-essential");
        const tile = !essential && isTile(tab);
        drag = {
          tab,
          // Чем вкладка была в начале: плиткой в сетке закреплённых или строкой списка.
          tile,
          row: !essential && !tile,
          width: rect.width,
          height: rect.height,
          owned: false,
          started: false,
          // Стоит ли в _dragData цель, поставленная модом.
          armed: false,
          image: {
            // У важной вкладки вид картинки ведёт Zen, поэтому свой считаем неизвестным.
            form: essential ? null : tile,
            startTile: tile,
            offsets: this.originalDragImageArgs.slice(1),
          },
        };
        if (tile) {
          // Копию для картинки Zen кладёт вне сетки, и она рисуется строкой
          // шириной в плитку. Этот признак возвращает ей вид плитки.
          imageParts()?.clone.setAttribute("zbm-tile", "");
        }
        // Изображение важной вкладки система доводит до места из неверной
        // точки. Переписать этот полёт мод не может, только не запускать его.
        if (essential && getPref(PREF_NO_ESSENTIAL_LANDING)) {
          this._dropLandingArmed = false;
          this.ZenDragAndDropService.armDropLanding(false);
        }
      });
      return result;
    },

    _animateTabMove(event) {
      let handled = false;
      guarded(() => {
        handled = liveMove(event);
      });
      return handled ? undefined : originals._animateTabMove.call(this, event);
    },

    handle_drop(event) {
      dropping = false;
      dragActive = false;
      stopEdgeScroll();
      guarded(() => {
        cancelHover();
        clearTimeout(settleTimer);
        const tab = gap?.tab;
        if (!gap || !tab?._dragData) {
          return;
        }
        const zone = zoneOf(event);
        const anchor = gap.drop.element;
        const valid =
          zone &&
          zone.ws === gap.ws &&
          zone.pinned === gap.pinned &&
          gap.container.isConnected &&
          (!anchor || zone.ws.contains(anchor)) &&
          event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0) === tab &&
          event.dataTransfer.dropEffect === "move" &&
          // Zen уже показал разделение экрана: бросок создаёт его, а не переставляет вкладку.
          !this._splitDropReady;
        if (valid) {
          // Firefox снимает места строк до переноса и после. Анимация не
          // должна сдвигать их в этот момент.
          cancelRunning();
          tab._dragData.dropElement = gap.drop.element;
          tab._dragData.dropBefore = gap.drop.before;
          dropping = true;
        } else {
          removeGapAttributes();
          disarm();
        }
      });
      const live = dropping;
      try {
        return originals.handle_drop.call(this, event);
      } finally {
        dropping = false;
        guarded(endDrag);
        if (live) {
          requestAnimationFrame(() => guarded(stopFirefoxDropAnimation));
        }
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
      // Вкладка уже перенесена. Если плитки вынесены над прокруткой, она
      // должна встать в сетку до того, как Zen измерит её место.
      guarded(() => syncTiles(activeWorkspace()));
      return originals._handle_dropCreateSplit.call(this, ...args);
    },

    // Zen делит экран, если задержать вкладку над серединой другой вкладки.
    // С настройкой мода он этого не предлагает: бросок только переставляет.
    _handle_tabDragOverToSplit(...args) {
      if (getPref(PREF_NO_SPLIT)) {
        return undefined;
      }
      return originals._handle_tabDragOverToSplit.call(this, ...args);
    },

    handle_dragend(event) {
      try {
        return originals.handle_dragend.call(this, event);
      } finally {
        dragActive = false;
        stopEdgeScroll();
        guarded(() => {
          cancelHover();
          clearTimeout(settleTimer);
          holdUntil = 0;
          clearGap(true);
          drag = null;
        });
      }
    },
  };

  // Вкладку утащили с панели на страницу: проекция в списке больше не нужна.
  function onWindowDragOver(event) {
    if ((gap || hover) && !event.target.closest?.("#navigator-toolbox")) {
      guarded(release);
    }
    if (dragActive || edge) {
      try {
        updateEdgeScroll(event);
      } catch (error) {
        console.error("[zen-browser-mod] edge scroll failed:", error);
        stopEdgeScroll();
      }
    }
  }

  // Вкладку унесли за пределы окна. Бросок в другое окно может не прислать
  // сюда dragend, поэтому проекцию убираем сразу.
  function onWindowDragLeave(event) {
    if (!event.relatedTarget) {
      stopEdgeScroll();
    }
    if ((gap || hover) && !event.relatedTarget) {
      guarded(release);
    }
  }

  // Во время перетаскивания окно не получает mousemove. Раз он пришёл, а
  // проекция ещё стоит, перетаскивание кончилось без dragend.
  function onMouseMove() {
    dragActive = false;
    stopEdgeScroll();
    if (gap || drag?.owned) {
      guarded(() => {
        release();
        drag = null;
      });
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
    window.addEventListener("dragleave", onWindowDragLeave, true);
    window.addEventListener("mousemove", onMouseMove, true);
    Services.prefs.addObserver(PREF_SPACE_ROW, prefObserver);
    syncSpaceRows();
  }

  function uninstall() {
    disposed = true;
    clearTimeout(readyTimer);
    stopEdgeScroll();
    dragActive = false;
    if (!dnd) {
      return;
    }
    guarded(endDrag);
    drag = null;
    for (const [name, wrapper] of Object.entries(wrappers)) {
      // Обёртки лежат собственными свойствами поверх методов класса.
      if (Object.hasOwn(dnd, name) && dnd[name] === wrapper) {
        delete dnd[name];
      }
    }
    window.removeEventListener("dragover", onWindowDragOver, true);
    window.removeEventListener("dragleave", onWindowDragLeave, true);
    window.removeEventListener("mousemove", onMouseMove, true);
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
