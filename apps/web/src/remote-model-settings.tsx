import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { defaultRemotePresets, effortLabels, type ComposerOptions } from "./remote-composer-model";
import { listRemoteModels } from "./remote-api";
import { RemoteNotice } from "./remote-notice";
import { RemoteSpeedIcon, RemoteSpeedParticles } from "./remote-speed-icon";
import { SfSymbol } from "./sf-symbol";
import "./remote-composer.css";

export function RemoteModelSettings({
  options,
  onOptions,
  menu,
  setMenu,
  currentModel,
  currentEffort,
  busy = false,
  inputHasFocus = () => false,
}: {
  options: ComposerOptions;
  onOptions: (value: ComposerOptions) => void;
  menu: "model" | "models";
  setMenu: (value: "model" | "models") => void;
  currentModel?: string | undefined;
  currentEffort?: string | undefined;
  busy?: boolean;
  inputHasFocus?: () => boolean;
}) {
  const tooltipId = useId();
  const rangePointer = useRef<number | null>(null);
  const [showSpeedInfo, setShowSpeedInfo] = useState(false);
  useEffect(() => {
    if (!showSpeedInfo) return;
    const timer = setTimeout(() => setShowSpeedInfo(false), 2500);
    return () => clearTimeout(timer);
  }, [showSpeedInfo]);
  const simplePanel = useRef<HTMLDivElement>(null);
  const listPanel = useRef<HTMLDivElement>(null);
  const [pickerHeight, setPickerHeight] = useState<number>();
  const models = useQuery({
    queryKey: ["remote-models"],
    queryFn: listRemoteModels,
    enabled: menu === "model" || menu === "models",
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  useLayoutEffect(() => {
    const panel = menu === "models" ? listPanel.current : simplePanel.current;
    if (!panel) return;
    const measure = () => setPickerHeight(panel.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [menu, models.data]);
  const selected = models.data?.find((model) => model.id === (options.model ?? currentModel));
  const effort =
    options.effort ??
    (!options.model || selected?.id === currentModel ? currentEffort : undefined) ??
    selected?.defaultEffort;
  const isDefault = options.selectionMode === "default";
  const desktopPresets = defaultRemotePresets(models.data ?? []);
  const catalogDefault = models.data?.find((model) => model.isDefault);
  const defaultPreset =
    desktopPresets.find(
      (p) => p.model === catalogDefault?.id && p.effort === catalogDefault.defaultEffort,
    ) ??
    desktopPresets.find((p) => p.model === catalogDefault?.id && p.effort === "medium") ??
    desktopPresets.find((p) => p.effort === "medium") ??
    desktopPresets[0];
  const defaultAvailable = Boolean(defaultPreset);
  const resetDefault = () => {
    if (!defaultPreset) return;
    onOptions({
      ...options,
      ...defaultPreset,
      selectionMode: "default",
      serviceTier: models.data
        ?.find((m) => m.id === defaultPreset.model)
        ?.serviceTiers.some((t) => t.id === options.serviceTier)
        ? options.serviceTier
        : null,
    });
  };
  useEffect(() => {
    if (!models.data || !isDefault) return;
    if (desktopPresets.some((p) => p.model === options.model && p.effort === options.effort))
      return;
    if (defaultPreset) onOptions({ ...options, ...defaultPreset, serviceTier: null });
    else onOptions({ ...options, selectionMode: "model" });
  }, [models.data, isDefault, options, onOptions, desktopPresets, defaultPreset]);
  const speedTiers = selected?.serviceTiers ?? [];
  const speedTier = speedTiers.find((tier) => tier.id === options.serviceTier);
  const fastTier = speedTiers.find(
    (tier) => tier.id === "priority" || tier.id === "fast" || tier.name.toLowerCase() === "fast",
  );
  const shownTier = speedTier ?? fastTier;
  const speedLabel =
    shownTier?.description?.match(/^[\d.]+[x×] speed/i)?.[0]?.replace("x", "×") ??
    shownTier?.name ??
    "倍速不可用";
  const cycleSpeed = () => {
    const index = speedTiers.findIndex((tier) => tier.id === options.serviceTier);
    onOptions({ ...options, serviceTier: speedTiers[index + 1]?.id ?? null });
    setShowSpeedInfo(true);
  };
  const presets = isDefault
    ? defaultRemotePresets(models.data ?? [])
    : (selected?.efforts ?? []).map((effort) => ({ model: selected!.id, effort }));
  const effortIndex = presets.findIndex(
    (preset) => preset.model === options.model && preset.effort === effort,
  );
  const choosePreset = (index: number) => {
    const preset = presets[index];
    if (!preset) return;
    const model = models.data?.find((model) => model.id === preset.model);
    onOptions({
      ...options,
      ...preset,
      serviceTier: model?.serviceTiers.some((tier) => tier.id === options.serviceTier)
        ? options.serviceTier
        : null,
    });
  };
  const dragEffort = (event: PointerEvent<HTMLInputElement>) => {
    if (!presets.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left - 16) / Math.max(1, bounds.width - 32)),
    );
    choosePreset(Math.round(ratio * (presets.length - 1)));
  };
  return (
    <>
      {menu === "model" && (
        <span
          id={tooltipId}
          role="tooltip"
          className={`remote-speed-tooltip${showSpeedInfo ? " is-visible" : ""}`}
        >
          <strong>{speedLabel}</strong>
          <small>{speedTiers.length ? "用量更多" : "此模型暂不支持加速"}</small>
        </span>
      )}

      <>
        {models.isPending ? (
          <p role="status">正在加载模型…</p>
        ) : models.isError ? (
          <>
            <RemoteNotice
              action={
                <button
                  type="button"
                  disabled={models.isFetching}
                  onClick={() => void models.refetch()}
                >
                  {models.isFetching ? "刷新中…" : "刷新"}
                </button>
              }
            >
              暂时无法加载模型，请刷新后重试。
            </RemoteNotice>
            <button type="button" onClick={() => void models.refetch()}>
              重试
            </button>
          </>
        ) : (
          <div className="remote-picker-views" data-view={menu} style={{ height: pickerHeight }}>
            <div
              className="remote-picker-list-panel"
              ref={listPanel}
              inert={menu !== "models"}
              aria-hidden={menu !== "models"}
            >
              <p>选择模型</p>
              <div className="remote-model-list">
                <button
                  type="button"
                  aria-pressed={isDefault}
                  disabled={!defaultAvailable}
                  onClick={() => {
                    resetDefault();
                    setMenu("model");
                  }}
                >
                  <span>
                    Default
                    <small>
                      {defaultAvailable ? "Desktop 推荐模型组合" : "Desktop 推荐档位暂不可用"}
                    </small>
                  </span>
                  {isDefault && <SfSymbol name="checkmark" />}
                </button>
                {models.data?.map((model) => (
                  <button
                    type="button"
                    key={model.id}
                    aria-pressed={!isDefault && selected?.id === model.id}
                    onClick={() => {
                      onOptions({
                        ...options,
                        model: model.id,
                        effort: model.defaultEffort,
                        selectionMode: "model",
                        serviceTier: null,
                      });
                      setMenu("model");
                    }}
                  >
                    {model.name}
                    {!isDefault && selected?.id === model.id && <SfSymbol name="checkmark" />}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="remote-picker-simple-panel"
              ref={simplePanel}
              inert={menu !== "model"}
              aria-hidden={menu !== "model"}
            >
              <div
                className="remote-model-picker-heading"
                data-default={isDefault}
                data-ultra={effort === "ultra"}
              >
                <span className="remote-speed-control">
                  <button
                    type="button"
                    className="remote-speed-toggle"
                    aria-label={`${speedLabel}，${speedTier ? "已开启，点击关闭" : "点击开启"}`}
                    aria-pressed={!!speedTier}
                    aria-describedby={tooltipId}
                    disabled={!speedTiers.length}
                    onClick={cycleSpeed}
                  >
                    <RemoteSpeedIcon active={!!speedTier} />
                  </button>
                </span>
                <button type="button" aria-label="选择模型" onClick={() => setMenu("models")}>
                  <strong key={`${options.model}:${effort}:${isDefault}`}>
                    {isDefault
                      ? `${selected?.name ?? "Desktop 默认"} ${effortLabels[effort ?? ""] ?? effort ?? ""}`
                      : (effortLabels[effort ?? ""] ?? effort ?? "选择档位")}{" "}
                    <SfSymbol name="chevron.right" />
                  </strong>
                  {!isDefault && <span>{selected?.name || currentModel || "选择模型"}</span>}
                </button>
                <button
                  type="button"
                  aria-label="Reset to default"
                  title="Reset to default"
                  disabled={!defaultAvailable}
                  style={{ visibility: isDefault ? "hidden" : "visible" }}
                  onClick={resetDefault}
                >
                  <SfSymbol name="arrow.counterclockwise" />
                </button>
              </div>
              {presets.length > 0 && (
                <div
                  className="remote-effort-slider"
                  data-ultra={effort === "ultra"}
                  data-fast={!!speedTier}
                  style={
                    {
                      "--effort-ratio": Math.max(0, effortIndex) / Math.max(1, presets.length - 1),
                    } as CSSProperties
                  }
                >
                  <span className="remote-slider-track" aria-hidden="true">
                    <span>{speedTier && <RemoteSpeedParticles />}</span>
                  </span>
                  <span className="remote-slider-thumb" aria-hidden="true" />
                  <input
                    type="range"
                    onPointerDown={(event) => {
                      if (!inputHasFocus()) return;
                      event.preventDefault();
                      rangePointer.current = event.pointerId;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      dragEffort(event);
                    }}
                    onPointerMove={(event) => {
                      if (rangePointer.current === event.pointerId) dragEffort(event);
                    }}
                    onPointerUp={(event) => {
                      if (rangePointer.current === event.pointerId) rangePointer.current = null;
                    }}
                    onPointerCancel={() => {
                      rangePointer.current = null;
                    }}
                    aria-label="推理强度"
                    aria-valuetext={
                      isDefault
                        ? `${selected?.name ?? options.model} · ${effortLabels[effort ?? ""] ?? effort}`
                        : (effortLabels[effort ?? ""] ?? effort)
                    }
                    min={0}
                    max={presets.length - 1}
                    step={1}
                    value={Math.max(0, effortIndex)}
                    disabled={presets.length === 1}
                    onChange={(event) => choosePreset(Number(event.target.value))}
                  />
                  <div aria-hidden="true">
                    {presets.map((item, index) => (
                      <span
                        key={`${item.model}:${item.effort}`}
                        style={{ visibility: index === effortIndex ? "hidden" : "visible" }}
                      />
                    ))}
                  </div>
                </div>
              )}
              {busy && (
                <RemoteNotice className="remote-settings-note" role="status">
                  当前回合与排队消息保持原设置；用于空闲后的发送
                </RemoteNotice>
              )}
            </div>
          </div>
        )}
      </>
    </>
  );
}
