"""Loader for the Valmet × Since AI synthetic builder pack (Excel)."""
from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np
import pandas as pd


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%d %H:%M")
    df = df.astype(object)
    return df.where(pd.notna(df), None)


@dataclass
class BuilderPack:
    path: Path

    @cached_property
    def xl(self) -> pd.ExcelFile:
        return pd.ExcelFile(self.path)

    def sheet(self, name: str) -> pd.DataFrame:
        return _clean(pd.read_excel(self.xl, name))

    @cached_property
    def assets(self) -> pd.DataFrame:
        a = self.sheet("Asset_Master")
        s = self.sheet("Current_State").drop(columns=["tag", "asset_class", "area_name", "criticality",
                                                      "synthetic_record"])
        return a.merge(s, on="asset_id", how="left")

    @cached_property
    def telemetry(self) -> pd.DataFrame:
        t = pd.read_excel(self.xl, "Telemetry_Sample_3d")
        return t.sort_values("timestamp")

    @cached_property
    def events(self) -> pd.DataFrame:
        return self.sheet("Alarms_Events").sort_values("timestamp", ascending=False)

    @cached_property
    def work_orders(self) -> pd.DataFrame:
        return self.sheet("Maintenance_History").sort_values("opened_at", ascending=False)

    @cached_property
    def cases(self) -> pd.DataFrame:
        return self.sheet("Historical_Service_Cases")

    @cached_property
    def docs(self) -> pd.DataFrame:
        return self.sheet("Knowledge_Docs")

    @cached_property
    def rag_index(self) -> pd.DataFrame:
        return self.sheet("RAG_Corpus_Index")

    @cached_property
    def data_quality(self) -> pd.DataFrame:
        return self.sheet("Data_Quality")

    @cached_property
    def anchors(self) -> pd.DataFrame:
        return self.sheet("Scene_Anchors")

    def asset(self, asset_id: str) -> dict:
        row = self.assets[self.assets.asset_id == asset_id]
        if row.empty:
            raise KeyError(asset_id)
        return row.iloc[0].to_dict()


CRIT_W = {"A": 1.0, "B": 0.7, "C": 0.45}
SIGNALS = {
    "PROCESS_PUMP": ["vibration_mm_s", "bearing_temp_c", "process_pressure_bar", "process_flow_pct", "motor_current_a"],
    "ELECTRIC_MOTOR": ["vibration_mm_s", "bearing_temp_c", "motor_current_a", "speed_rpm"],
    "CONTROL_VALVE": ["position_setpoint_pct", "position_actual_pct", "pneumatic_supply_bar", "stiction_index",
                      "load_for_opening_pct", "process_pressure_bar"],
    "PRESSURE_TRANSMITTER": ["process_pressure_bar", "signal_quality_pct", "sensor_bias"],
    "VIBRATION_SENSOR": ["vibration_mm_s", "signal_quality_pct", "sensor_bias"],
}
UNITS = {"vibration_mm_s": "mm/s", "bearing_temp_c": "°C", "process_pressure_bar": "bar", "process_flow_pct": "%",
         "motor_current_a": "A", "speed_rpm": "rpm", "position_setpoint_pct": "%", "position_actual_pct": "%",
         "pneumatic_supply_bar": "bar", "stiction_index": "", "load_for_opening_pct": "%",
         "signal_quality_pct": "%", "sensor_bias": ""}


def priority_score(a: dict) -> float:
    """Maintenance priority = criticality × (100-health) × model confidence (Builder question Q-04)."""
    crit = CRIT_W.get(str(a.get("criticality", "C"))[0], 0.45)
    return round(crit * (100 - float(a.get("health_score") or 100)) * float(a.get("model_confidence") or 0.5), 2)


def telemetry_evidence(pack: BuilderPack, asset_id: str, asset_class: str) -> dict:
    """Multivariate trend evidence: last 12 h vs the asset's own first 24 h baseline + class peer baseline."""
    t = pack.telemetry
    mine = t[t.asset_id == asset_id]
    peers = t[(t.asset_class == asset_class) & (t.asset_id != asset_id)]
    out = []
    if mine.empty:
        return {"signals": [], "window": None, "n_records": 0}
    t_end = mine.timestamp.max()
    recent = mine[mine.timestamp > t_end - pd.Timedelta(hours=12)]
    base = mine[mine.timestamp <= mine.timestamp.min() + pd.Timedelta(hours=24)]
    for sig in SIGNALS.get(asset_class, []):
        if sig not in mine or mine[sig].isna().all():
            continue
        r, b = recent[sig].dropna(), base[sig].dropna()
        p = peers[sig].dropna()
        if r.empty or b.empty:
            continue
        b_std = float(b.std() or 1e-6)
        p_mean, p_std = (float(p.mean()), float(p.std() or 1e-6)) if len(p) else (None, None)
        z_self = (float(r.mean()) - float(b.mean())) / b_std
        z_peer = (float(r.mean()) - p_mean) / p_std if p_mean is not None else None
        # linear trend over the full window (units per day)
        x = (mine.timestamp - mine.timestamp.min()).dt.total_seconds() / 86400
        y = mine[sig]
        k = y.notna()
        slope = float(np.polyfit(x[k], y[k], 1)[0]) if k.sum() > 3 else 0.0
        flag = abs(z_peer or 0) >= 2.0 or abs(z_self) >= 3.0
        series = mine[["timestamp", sig]].dropna().iloc[::3]
        out.append({
            "signal": sig, "unit": UNITS.get(sig, ""),
            "recent_mean": round(float(r.mean()), 3), "baseline_mean": round(float(b.mean()), 3),
            "peer_mean": round(p_mean, 3) if p_mean is not None else None,
            "z_vs_own_baseline": round(z_self, 2), "z_vs_peers": round(z_peer, 2) if z_peer is not None else None,
            "trend_per_day": round(slope, 4), "abnormal": bool(flag),
            "series": [[ts.strftime("%m-%d %H:%M"), round(float(v), 3)] for ts, v in zip(series.timestamp, series[sig])],
        })
    out.sort(key=lambda s: -abs(s["z_vs_peers"] or s["z_vs_own_baseline"]))
    return {"signals": out, "window": [str(mine.timestamp.min()), str(t_end)], "n_records": int(len(mine)),
            "source": "Telemetry_Sample_3d (30-min synthetic stream)"}
