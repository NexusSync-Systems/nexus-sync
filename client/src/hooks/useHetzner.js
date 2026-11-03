import { useState, useEffect, useCallback } from "react";
import * as tokenStore from '../services/tokenStore';
import axios from "axios";


import { API_BASE } from '../constants/config';
// Infrastrukturní endpointy smí jen app owner. DashboardHome je ale volal pro
// každého přihlášeného, takže operátorkám běžela na pozadí smyčka, která se
// každých 30 vteřin doptávala na 403 — donekonečna, dokud měly otevřenou
// záložku. Kromě zbytečné zátěže tím konzole zaplavila chybami, mezi kterými
// nebylo vidět nic skutečného. Parametr `enabled` to vypne; InfraTab (jen pro
// ownera) ho nechává na výchozím true.
export function useHetzner({ enabled = true } = {}) {
  const [status, setStatus] = useState(null);
  const [bandwidth, setBandwidth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cmdOutput, setCmdOutput] = useState("");
  const [_err, setError] = useState(null);
  const [stats, setStats] = useState(null);

  const getHeaders = useCallback(() => {
    const token = tokenStore.getToken();
    return {
      headers: { Authorization: `Bearer ${token}` }
    };
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!enabled) return;
    try {
      const [statusRes, metricsRes] = await Promise.all([
        axios.get(`${API_BASE}/hetzner/status`, getHeaders()),
        axios.get(`${API_BASE}/hetzner/metrics`, getHeaders()).catch(() => ({ data: null }))
      ]);
      setStatus(statusRes.data);
      if (metricsRes.data) {
        setBandwidth({
          incoming_bytes: metricsRes.data.incoming_bytes,
          outgoing_bytes: metricsRes.data.outgoing_bytes
        });
      }
      setError(null);
    } catch (err) {
      console.error("Failed to fetch Hetzner status:", err);
      setError(
        err.response?.data?.details?.error?.message || 
        err.response?.data?.details?.message || 
        err.response?.data?.error || 
        err.message
      );
    }
  }, [getHeaders, enabled]);

  const fetchStats = useCallback(async () => {
    if (!enabled) return;
    try {
      const { data } = await axios.get(`${API_BASE}/agency/stats`, getHeaders());
      setStats(data);
    } catch (err) {
      console.warn("Failed to fetch global stats:", err);
    }
  }, [getHeaders, enabled]);

  useEffect(() => {
    fetchStatus();
    fetchStats();
    const interval = setInterval(() => {
      fetchStatus();
      fetchStats();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchStats, enabled]);

  const serverAction = async (action) => {
    setLoading(true);
    try {
      await axios.post(`${API_BASE}/hetzner/${action}`, {}, getHeaders());
      setTimeout(fetchStatus, 3500);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || err.message);
    } finally {
      setLoading(false);
    }
  };

  const runCommand = async (command) => {
    if (!command) return;
    setCmdOutput("Spouštím na AI Node...");
    try {
      const { data } = await axios.post(`${API_BASE}/hetzner/command`, { command }, getHeaders());
      setCmdOutput(data.stdout || data.stderr || "Žádný výstup");
    } catch (err) {
      setCmdOutput("Error: " + (err.response?.data?.error || err.response?.data?.message || err.message));
    }
  };

  const gitPull = async (path) => {
    setCmdOutput("Stahuji změny na AI Node...");
    try {
      const { data } = await axios.post(`${API_BASE}/hetzner/git-pull`, { path }, getHeaders());
      setCmdOutput(data.stdout || data.stderr || "Git pull dokončen");
    } catch (err) {
      setCmdOutput("Error: " + (err.response?.data?.error || err.response?.data?.message || err.message));
    }
  };

  const clearCmdOutput = () => setCmdOutput("");

  return { status, bandwidth, stats, loading, cmdOutput, clearCmdOutput, _err, serverAction, runCommand, gitPull, fetchStatus };
}
