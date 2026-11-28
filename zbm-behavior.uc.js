/*
 * Правки поведения боковой панели, не связанные с перетаскиванием:
 * свёрнутые папки и закреплённые, переименование папки, число колонок в сетке закреплённых,
 * подсказка у крестика, автопрокрутка списка, значки пространств и жест
 * перелистывания пространств. Каждая включается своей настройкой и проверяет её в момент
 * срабатывания.
 *
 * Сверено с исходниками Zen 1.24.3b: ZenFolders.mjs, ZenFolder.mjs,
 * ZenSpace.mjs, ZenSpacesSwipe.mjs, ZenSpaceManager.mjs, ZenSpaceIcons.mjs.
 */
(() => {
  "use strict";

  const PREF_COLLAPSE_HIDES_ALL = "mod.zbm.folders.collapse-hides-all";
  const PREF_NO_AUTOSCROLL = "mod.zbm.sidebar.no-autoscroll-on-space-switch";
  const PREF_SWIPE = "mod.zbm.swipe.easier";
  const PREF_SWIPE_THRESHOLD = "mod.zbm.swipe.threshold";
  const PREF_SWIPE_VELOCITY = "mod.zbm.swipe.velocity";
  const PREF_PINS_GRID = "mod.zbm.pins.grid";
  const PREF_MAX_THREE = "mod.zbm.tiles.max-three";
  const PREF_SPACE_ICONS = "mod.zbm.spaces.keep-icons";
  const PREF_RENAME_CLICK = "mod.zbm.folders.rename-click";
  const PREF_UNLOAD_HIDE = "mod.zbm.unload.hide";
  const PREF_ZEN_CLOSE_BEHAVIOR = "zen.pinned-tab-manager.close-shortcut-behavior";

  // Zen анимирует папку около 180 мс. Свою правку начинаем после него,
  // чтобы две анимации одной папки не шли одновременно.
  const FOLDER_SETTLE_MS = 350;
  // Столько же длится сворачивание папок в Zen.
  const PINS_ANIMATION_MS = 180;

  const root = document.documentElement;

  const getPref = name => Services.prefs.getBoolPref(name, false);
  const getNumber = (name, fallback) => {
    const value = Number(Services.prefs.getStringPref(name, ""));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  let disposed = false;
  let readyTimer = null;
  const cleanups = [];
  const listen = (target, type, handler, capture = false) => {
    target.addEventListener(type, handler, capture);
    cleanups.push(() => target.removeEventListener(type, handler, capture));
  };

  /*
   * Свёрнутая папка прячет все вкладки.
   *
   * Zen оставляет под свёрнутой папкой вкладку, которая была активной, и
   * убирает её только при выгрузке. Здесь при сворачивании уходит и активная,
   * а вкладка, показанная позже, уходит внутрь, как только с неё ушёл фокус.
   * То же для закреплённых вкладок пространства, свёрнутых кликом по его
   * названию: для Zen это такая же папка. Вкладки при этом не выгружаются.
   *
   * Смена пространства папки не трогает: вкладка, спрятанная в свёрнутую
   * папку, не достаётся наружу оттого, что пространство снова открыли, а
   * показанная не прячется оттого, что из него ушли.
   */
  const folderOf = tab =>
    tab.group?.hasAttribute("split-view-group") ? tab.group.group : tab.group;

  const isCollapsiblePins = group =>
    group?.localName === "zen-workspace-collapsible-pins";

  /**
   * Папка, под которой вкладка сейчас показана как активная. Для вкладки в
   * раскрытой папке внутри свёрнутых закреплённых это сами закреплённые:
   * в цепочке папок вкладки Zen их не держит.
   */
  function activeOwner(tab) {
    const folder = folderOf(tab);
    if (folder?.isZenFolder && folder.activeGroups?.length) {
      return folder;
    }
    const pins = window.gZenWorkspaces?.workspaceElement?.(
      tab.getAttribute("zen-workspace-id")
    )?.collapsiblePins;
    const inPins = tab.pinned && !tab.hasAttribute("zen-essential");
    return inPins && pins?.collapsed && pins.hasAttribute("has-active") ? pins : null;
  }

  /** Убирает внутрь вкладки, оставшиеся на виду под свёрнутыми папками, кроме выбранной. */
  async function hideIntoFolders() {
    const tabs = [...document.querySelectorAll(".tabbrowser-tab[folder-active]")];
    for (const tab of tabs) {
      // Пока шла предыдущая анимация, всё могло поменяться: проверяем заново.
      if (disposed || !getPref(PREF_COLLAPSE_HIDES_ALL)) {
        return;
      }
      if (
        !tab.isConnected ||
        !tab.hasAttribute("folder-active") ||
        tab.selected ||
        tab.multiselected ||
        // Другие пространства остаются такими, какими их оставили.
        tab.getAttribute("zen-workspace-id") !== gZenWorkspaces.activeWorkspace
      ) {
        continue;
      }
      const owner = activeOwner(tab);
      if (owner) {
        await gZenFolders.animateUnload(owner, tab);
      }
    }
  }

  const changingSpace = () => !!window.gZenWorkspaces?.isChangingWorkspace;

  let hideTimer = null;
  function scheduleHide() {
    if (changingSpace()) {
      return;
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      hideIntoFolders().catch(error =>
        console.error("[zen-browser-mod] hiding folder tab failed:", error)
      );
    }, FOLDER_SETTLE_MS);
  }

  /**
   * На время вызова делает так, что Zen не видит в папке выбранных вкладок.
   * Какие вкладки оставить на виду, animateCollapse решает в самом начале, до
   * первой паузы, по tab.selected и tab.multiselected. Без них он сворачивает
   * папку целиком одной анимацией, как папку без активных вкладок.
   *
   * @returns {Function} Возвращает вкладкам настоящие свойства.
   */
  function pretendNothingSelected(group) {
    const shadowed = [];
    const container = group.groupContainer;
    for (const tab of container?.querySelectorAll(".tabbrowser-tab") ?? []) {
      if (tab.selected || tab.multiselected) {
        for (const name of ["selected", "multiselected"]) {
          Object.defineProperty(tab, name, { get: () => false, configurable: true });
        }
        shadowed.push(tab);
      }
    }
    return () => {
      for (const tab of shadowed) {
        delete tab.selected;
        delete tab.multiselected;
      }
    };
  }

  const pinsAnimations = new Map();

  /** Секция закреплённых, если сворачивают их и они сейчас стоят сеткой. */
  function pinsGridSection(group) {
    const expanded = root.getAttribute("zen-sidebar-expanded") === "true";
    return isCollapsiblePins(group) && expanded && getPref(PREF_PINS_GRID)
      ? group.groupContainer
      : null;
  }

  /**
   * Части области закреплённых, у которых при сворачивании меняется высота:
   * сама секция и обёртка плиток, если zbm-pins.uc.js вынес плитки над
   * прокруткой.
   */
  function pinsParts(section) {
    const tiles = section.hasAttribute("zbm-split")
      ? section.shadowRoot?.getElementById("zbm-tiles")
      : null;
    return tiles ? [section, tiles] : [section];
  }

  /** Высоты частей до переключения, снятые без пересчёта раскладки. */
  function pinsHeights(section) {
    return new Map(
      pinsParts(section).map(part => [
        part,
        window.windowUtils.getBoundsWithoutFlushing(part).height,
      ])
    );
  }

  /**
   * Сворачивание и раскрытие сетки закреплённых. Zen сдвигает содержимое
   * области вверх отступом служебного элемента, а в сетке такой сдвиг не
   * работает. Поэтому здесь высоту области ведёт своя анимация, а конечный
   * вид свёрнутой области задан в chrome.css.
   *
   * @param {Element} section - Секция закреплённых.
   * @param {Map<Element, number>} from - Высоты её частей до переключения.
   */
  function animatePins(section, from) {
    // Прошлая анимация могла не закончиться: её высота мешала бы измерить конечную.
    for (const animation of pinsAnimations.get(section) ?? []) {
      animation.cancel();
    }
    pinsAnimations.delete(section);
    section.removeAttribute("zbm-pins-anim");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // Высоты после переключения: атрибут Zen уже поменял, пересчёт даёт конечный вид.
    section._zbmSyncTiles?.();
    const changes = [];
    for (const [part, was] of from) {
      const to = part.getBoundingClientRect().height;
      if (Math.abs(was - to) >= 1) {
        changes.push([part, was, to]);
      }
    }
    if (!changes.length) {
      return;
    }
    // Если какая-то плитка остаётся на виду, остальные убираются сразу: иначе
    // она ехала бы на своём старом месте в сетке и в конце перескакивала.
    const tiles = pinsParts(section)[1];
    const keepsTile = !!tiles && tiles.getBoundingClientRect().height >= 1;
    section.setAttribute("zbm-pins-anim", keepsTile ? "keep" : "");
    const animations = changes.map(([part, was, to]) =>
      part.animate([{ height: `${was}px` }, { height: `${to}px` }], {
        duration: PINS_ANIMATION_MS,
        easing: "ease-in-out",
      })
    );
    pinsAnimations.set(section, animations);
    Promise.all(animations.map(animation => animation.finished)).then(
      () => {
        if (pinsAnimations.get(section) === animations) {
          pinsAnimations.delete(section);
          section.removeAttribute("zbm-pins-anim");
        }
      },
      () => {}
    );
  }

  function installFolderAnimations() {
    const folders = gZenFolders;

    const originalCollapse = folders.animateCollapse;
    const collapse = function (group, ...rest) {
      let restore = null;
      let section = null;
      let from = null;
      try {
        if (getPref(PREF_COLLAPSE_HIDES_ALL)) {
          restore = pretendNothingSelected(group);
        }
        section = pinsGridSection(group);
        from = section ? pinsHeights(section) : null;
      } catch (error) {
        console.error("[zen-browser-mod] folder collapse tweak failed:", error);
      }
      try {
        return originalCollapse.call(this, group, ...rest);
      } finally {
        try {
          restore?.();
          if (from) {
            animatePins(section, from);
          }
        } catch (error) {
          console.error("[zen-browser-mod] folder collapse tweak failed:", error);
        }
      }
    };

    const originalExpand = folders.animateExpand;
    const expand = function (group, ...rest) {
      let section = null;
      let from = null;
      try {
        section = pinsGridSection(group);
        from = section ? pinsHeights(section) : null;
      } catch (error) {
        console.error("[zen-browser-mod] folder expand tweak failed:", error);
      }
      try {
        return originalExpand.call(this, group, ...rest);
      } finally {
        try {
          if (from) {
            animatePins(section, from);
          }
        } catch (error) {
          console.error("[zen-browser-mod] folder expand tweak failed:", error);
        }
      }
    };

    // Выбранную вкладку свёрнутой папки достаёт наружу обработчик Zen. При
    // смене пространства вкладка выбирается сама, без действия человека.
    const originalSelect = folders.on_TabSelect;
    const select = function (...args) {
      let skip = false;
      try {
        skip = getPref(PREF_COLLAPSE_HIDES_ALL) && changingSpace();
      } catch (error) {
        console.error("[zen-browser-mod] folder select tweak failed:", error);
      }
      return skip ? undefined : originalSelect.apply(this, args);
    };

    folders.animateCollapse = collapse;
    folders.animateExpand = expand;
    folders.on_TabSelect = select;
    cleanups.push(() => {
      if (Object.hasOwn(folders, "on_TabSelect") && folders.on_TabSelect === select) {
        delete folders.on_TabSelect;
      }
      if (Object.hasOwn(folders, "animateCollapse") && folders.animateCollapse === collapse) {
        delete folders.animateCollapse;
      }
      if (Object.hasOwn(folders, "animateExpand") && folders.animateExpand === expand) {
        delete folders.animateExpand;
      }
      for (const [section, animations] of pinsAnimations) {
        for (const animation of animations) {
          animation.cancel();
        }
        section.removeAttribute("zbm-pins-anim");
      }
      pinsAnimations.clear();
    });
  }

  /*
   * Клик по строке папки, пока её переименовывают.
   *
   * Переключателем папки Zen считает любой клик внутри строки её заголовка,
   * а поле с названием стоит в этой же строке. Поэтому клик по названию,
   * чтобы поставить курсор, сворачивает папку, а нажатие рядом с полем ещё и
   * обрывает переименование. Пока в строке стоит поле, клик до папки не
   * доходит, а нажатие мимо поля не забирает у него фокус.
   */
  function renamingRow(target) {
    const row = target?.closest?.(".tab-group-label-container");
    return row?.querySelector(":scope > #tab-label-input") ? row : null;
  }

  function onRenameMouseDown(event) {
    if (
      event.button === 0 &&
      getPref(PREF_RENAME_CLICK) &&
      event.target.id !== "tab-label-input" &&
      renamingRow(event.target)
    ) {
      event.preventDefault();
    }
  }

  function onRenameClick(event) {
    if (getPref(PREF_RENAME_CLICK) && renamingRow(event.target)) {
      event.stopPropagation();
    }
  }

  /*
   * Колонок в сетке закреплённых столько же, сколько в сетке важных.
   *
   * Число колонок у важных Zen подбирает сам по их количеству и ширине
   * панели, настройки для него нет: предел в три колонки задаёт chrome.css по
   * настройке мода. Здесь число считается по готовой раскладке и передаётся
   * в chrome.css переменной. Если важные стоят в одну-две
   * колонки или их нет, переменной нет, и сетка считает колонки по-своему.
   */
  let columnsFrame = 0;
  function syncEssentialColumns() {
    columnsFrame = 0;
    let columns = 0;
    try {
      const moving = gBrowser.tabContainer.hasAttribute("movingtab");
      if (moving) {
        // При перетаскивании важные сдвинуты, считать по ним нельзя.
        return;
      }
      if (getPref(PREF_PINS_GRID)) {
        const container = gZenWorkspaces.getCurrentEssentialsContainer?.();
        const tabs = [...(container?.children ?? [])].filter(el => gBrowser.isTab(el));
        const first = tabs[0]?.getBoundingClientRect();
        if (first?.height) {
          columns = tabs.filter(
            tab => Math.abs(tab.getBoundingClientRect().top - first.top) < 1
          ).length;
        }
      }
    } catch (error) {
      console.error("[zen-browser-mod] essentials column count failed:", error);
    }
    // Предел сменили, а важные ещё не перестроились: сетке хватит самого предела.
    columns = Math.min(columns, getPref(PREF_MAX_THREE) ? 3 : 4);
    if (columns >= 3) {
      root.style.setProperty("--zbm-essential-columns", columns);
    } else {
      root.style.removeProperty("--zbm-essential-columns");
    }
  }

  function queueEssentialColumns() {
    if (!columnsFrame && !disposed) {
      columnsFrame = requestAnimationFrame(syncEssentialColumns);
    }
  }

  function installEssentialColumns() {
    const essentials = document.getElementById("zen-essentials");
    if (essentials) {
      const mutations = new MutationObserver(queueEssentialColumns);
      mutations.observe(essentials, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
      const resizes = new ResizeObserver(queueEssentialColumns);
      resizes.observe(essentials);
      cleanups.push(() => {
        mutations.disconnect();
        resizes.disconnect();
      });
    }
    const observer = { observe: queueEssentialColumns };
    Services.prefs.addObserver(PREF_PINS_GRID, observer);
    Services.prefs.addObserver(PREF_MAX_THREE, observer);
    // Конец перетаскивания: важные вернулись на места.
    listen(window, "dragend", queueEssentialColumns, true);
    listen(window, "drop", queueEssentialColumns, true);
    cleanups.push(() => {
      Services.prefs.removeObserver(PREF_PINS_GRID, observer);
      Services.prefs.removeObserver(PREF_MAX_THREE, observer);
      cancelAnimationFrame(columnsFrame);
      root.style.removeProperty("--zbm-essential-columns");
    });
    queueEssentialColumns();
  }

  /*
   * Подсказка у крестика закреплённой вкладки.
   *
   * Крестиком мод рисует кнопку Zen «выгрузить вкладку», и подсказка у неё
   * остаётся про выгрузку. Пока Zen настроен закрывать вкладку этой кнопкой,
   * подсказка берётся та же, что у обычного крестика.
   */
  const CLOSE_TOOLTIP = "tabbrowser-close-tabs-button";
  const UNLOAD_TOOLTIP = "tabbrowser-unload-tab-button";

  function onTabButtonHover(event) {
    const button = event.target;
    if (
      !button?.classList?.contains("tab-reset-button") ||
      !button.parentElement?.classList.contains("tab-content")
    ) {
      return;
    }
    const closes =
      getPref(PREF_UNLOAD_HIDE) &&
      Services.prefs.getStringPref(PREF_ZEN_CLOSE_BEHAVIOR, "") === "close";
    const wanted = closes ? CLOSE_TOOLTIP : UNLOAD_TOOLTIP;
    if (button.getAttribute("data-l10n-id") !== wanted) {
      document.l10n.setAttributes(button, wanted, { tabCount: 1 });
    }
  }

  function restoreTabButtonTooltips() {
    const changed = document.querySelectorAll(
      `.tab-content > .tab-reset-button[data-l10n-id="${CLOSE_TOOLTIP}"]`
    );
    for (const button of changed) {
      document.l10n.setAttributes(button, UNLOAD_TOOLTIP, { tabCount: 1 });
    }
  }

  /*
   * Список вкладок не прокручивается к активной вкладке при смене пространства.
   *
   * К активной вкладке список подводит _handleTabSelect. Пропускаем его вызовы,
   * пока Zen меняет пространство. Кнопка «прокрутить к вкладке» зовёт тот же
   * метод в другое время и продолжает работать.
   */
  function installAutoscrollGuard() {
    const container = gBrowser.tabContainer;
    const original = container._handleTabSelect;
    const wrapper = function (...args) {
      let skip = false;
      try {
        skip = getPref(PREF_NO_AUTOSCROLL) && !!window.gZenWorkspaces?.isChangingWorkspace;
      } catch (error) {
        console.error("[zen-browser-mod] autoscroll guard failed:", error);
      }
      return skip ? undefined : original.apply(this, args);
    };
    container._handleTabSelect = wrapper;
    cleanups.push(() => {
      if (Object.hasOwn(container, "_handleTabSelect") && container._handleTabSelect === wrapper) {
        delete container._handleTabSelect;
      }
    });
  }

  /*
   * Значки пространств внизу панели не превращаются в точки без причины.
   *
   * Zen заменяет значки точками, когда они не помещаются в полосу. Проверяет
   * он это при изменении размера окна и списка пространств, а ширину полосы
   * берёт без пересчёта раскладки. Если в этот момент ширина старая или
   * нулевая, точки остаются до следующей проверки, хотя места хватает.
   * Здесь проверка повторяется, как только у полосы поменялась ширина или
   * Zen включил точки. Если значки и правда не помещаются, точки остаются.
   */
  function installSpaceIconsCheck() {
    const strip = gZenWorkspaces.workspaceIcons;
    if (!strip) {
      return;
    }
    let frame = 0;
    let retryTimer = null;
    let retries = 0;
    const queue = () => {
      if (!frame && !disposed) {
        frame = requestAnimationFrame(recheck);
      }
    };
    function recheck() {
      frame = 0;
      if (disposed || !getPref(PREF_SPACE_ICONS)) {
        return;
      }
      // Пока Zen анимирует компактный режим, проверку он пропускает.
      if (gZenWorkspaces._processingResize) {
        if (retries++ < 10) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(queue, 300);
        }
        return;
      }
      retries = 0;
      try {
        // Чтение размера пересчитывает раскладку: Zen увидит настоящую ширину.
        strip.getBoundingClientRect();
        // Тот же путь, каким Zen проверяет значки при изменении размера окна.
        gZenWorkspaces.onWindowResize({ target: window });
      } catch (error) {
        console.error("[zen-browser-mod] space icons check failed:", error);
      }
    }
    const resizes = new ResizeObserver(queue);
    resizes.observe(strip);
    // Повторная установка того же атрибута самой проверкой сюда не попадает.
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.oldValue === null) && strip.hasAttribute("icons-overflow")) {
        queue();
      }
    });
    mutations.observe(strip, {
      attributes: true,
      attributeFilter: ["icons-overflow"],
      attributeOldValue: true,
    });
    const observer = { observe: queue };
    Services.prefs.addObserver(PREF_SPACE_ICONS, observer);
    cleanups.push(() => {
      resizes.disconnect();
      mutations.disconnect();
      Services.prefs.removeObserver(PREF_SPACE_ICONS, observer);
      cancelAnimationFrame(frame);
      clearTimeout(retryTimer);
    });
    queue();
  }

  /*
   * Жест перелистывания пространств.
   *
   * Удался ли свайп, решает система по двум числам, которые Zen кладёт в
   * каждое событие жеста: какую долю ширины надо протащить и сколько весит
   * скорость. Наш обработчик стоит после обработчика Zen и подменяет числа,
   * чтобы короткий быстрый жест тоже считался. Подменяем только обычное
   * перелистывание: у жеста «создать пространство» Zen ставит свой, высокий
   * порог, и его трогать нельзя, иначе пространства будут создаваться случайно.
   */
  function onSwipe(event) {
    if (!getPref(PREF_SWIPE) || !("swipeSuccessThreshold" in event)) {
      return;
    }
    const regular = window.gZenWorkspaces?._swipeManager?.constructor.SUCCESS_THRESHOLD ?? 0.25;
    if (Math.abs(event.swipeSuccessThreshold - regular) > 1e-6) {
      return;
    }
    event.swipeSuccessThreshold = Math.min(getNumber(PREF_SWIPE_THRESHOLD, 0.12), 0.9);
    event.swipeSuccessVelocityContribution = getNumber(PREF_SWIPE_VELOCITY, 1);
  }

  function install() {
    listen(window, "TabSelect", scheduleHide);
    installFolderAnimations();
    listen(gNavToolbox, "mousedown", onRenameMouseDown, true);
    listen(gNavToolbox, "click", onRenameClick, true);
    installEssentialColumns();
    listen(gNavToolbox, "mouseover", onTabButtonHover, true);
    cleanups.push(restoreTabButtonTooltips);
    installAutoscrollGuard();
    installSpaceIconsCheck();
    for (const type of ["MozSwipeGestureStart", "MozSwipeGestureUpdate"]) {
      listen(gNavToolbox, type, onSwipe, true);
    }
  }

  function uninstall() {
    disposed = true;
    clearTimeout(readyTimer);
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    clearTimeout(hideTimer);
  }

  // Ждём, пока Zen соберёт панель и повесит свой обработчик жеста: наш должен
  // встать после него, иначе последним числа запишет Zen.
  let attempts = 0;
  function whenReady() {
    if (disposed) {
      return;
    }
    let ready = false;
    try {
      ready = !!(
        window.gBrowser?.tabContainer &&
        window.gZenFolders &&
        window.gZenWorkspaces?.activeWorkspaceElement &&
        // Обработчика жеста может не быть вовсе, если жесты в Zen выключены.
        (window.gZenWorkspaces._swipeManager || attempts > 50)
      );
    } catch {}
    if (ready) {
      try {
        install();
      } catch (error) {
        console.error("[zen-browser-mod] behavior script failed to start:", error);
        uninstall();
      }
    } else if (attempts++ < 150) {
      readyTimer = setTimeout(whenReady, 200);
    }
  }
  whenReady();

  window.addUnloadListener?.(uninstall);
})();
