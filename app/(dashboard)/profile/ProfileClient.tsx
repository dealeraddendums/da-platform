"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DealerRow } from "@/lib/db";
import { PageHeader } from "@/components/PageHeader";
import type { LabelProduct } from "@/lib/label-products";
import { LABEL_PRODUCTS } from "@/lib/label-products";

type Tab = "info" | "shipping" | "labels" | "billing";

type Props = {
  dealer: DealerRow;
  canEdit: boolean;
  userEmail: string;
  userName: string;
};

// ── Dealership Info Tab ──────────────────────────────────────────────────────

function InfoTab({ dealer, canEdit }: { dealer: DealerRow; canEdit: boolean }) {
  const [form, setForm] = useState({
    name: dealer.name ?? "",
    primary_contact: dealer.primary_contact ?? "",
    primary_contact_email: dealer.primary_contact_email ?? "",
    phone: dealer.phone ?? "",
    address: dealer.address ?? "",
    city: dealer.city ?? "",
    state: dealer.state ?? "",
    zip: dealer.zip ?? "",
    country: dealer.country ?? "US",
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setSuccess(false);
    setError("");
    try {
      const res = await fetch(`/api/dealers/${dealer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  return (
    <div style={{ maxWidth: 560 }}>
      {dealer.logo_url && (
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Dealership Logo</label>
          <img
            src={dealer.logo_url}
            alt="Logo"
            style={{ maxHeight: 60, maxWidth: 200, objectFit: "contain", display: "block" }}
          />
        </div>
      )}

      <div style={rowStyle}>
        <Field label="Dealership Name" value={form.name} onChange={set("name")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Primary Contact" value={form.primary_contact} onChange={set("primary_contact")} disabled={!canEdit} />
        <Field label="Contact Email" value={form.primary_contact_email} onChange={set("primary_contact_email")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Phone" value={form.phone} onChange={set("phone")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Address" value={form.address} onChange={set("address")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="City" value={form.city} onChange={set("city")} disabled={!canEdit} />
        <Field label="State" value={form.state} onChange={set("state")} disabled={!canEdit} style={{ maxWidth: 80 }} />
        <Field label="Zip" value={form.zip} onChange={set("zip")} disabled={!canEdit} style={{ maxWidth: 100 }} />
      </div>

      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 12, color: "#78828c" }}>
          Internal ID: <strong>{dealer.internal_id ?? "—"}</strong>
        </span>
      </div>

      {canEdit && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
          {success && <span style={{ fontSize: 13, color: "#4caf50" }}>Saved</span>}
          {error && <span style={{ fontSize: 13, color: "#ff5252" }}>{error}</span>}
        </div>
      )}

      <PasskeyCard />
    </div>
  );
}

// ── Passkey / Security Card ───────────────────────────────────────────────────

type PasskeyRow = {
  id: string;
  friendly_name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
};

function PasskeyCard() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addSuccess, setAddSuccess] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      !!window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    ) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(available => setSupported(available))
        .catch(() => {});
    }
    fetchPasskeys();
  }, []);

  async function fetchPasskeys() {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/passkey/list");
      if (res.ok) {
        const d = await res.json() as { passkeys: PasskeyRow[] };
        setPasskeys(d.passkeys ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    setAddError("");
    setAddSuccess(false);
    setAdding(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");

      const startRes = await fetch("/api/auth/passkey/register-start", { method: "POST" });
      if (!startRes.ok) {
        const d = await startRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Could not start passkey registration.");
      }
      const options = await startRes.json();

      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("cancelled") || msg.includes("NotAllowedError")) {
          throw new Error("Registration was cancelled.");
        }
        throw e;
      }

      const completeRes = await fetch("/api/auth/passkey/register-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Registration failed.");
      }

      setAddSuccess(true);
      await fetchPasskeys();
      setTimeout(() => setAddSuccess(false), 3000);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Registration failed.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
    setDeletingId(id);
    try {
      await fetch(`/api/auth/passkey/${id}`, { method: "DELETE" });
      await fetchPasskeys();
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    try {
      await fetch(`/api/auth/passkey/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendly_name: editName.trim() }),
      });
      setEditingId(null);
      await fetchPasskeys();
    } catch {
      // ignore
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div
      style={{
        marginTop: 32,
        paddingTop: 24,
        borderTop: "1px solid #e0e0e0",
        maxWidth: 560,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c", margin: "0 0 4px" }}>
          Passkeys
        </h3>
        <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
          Sign in faster with Face ID, Touch ID, or your device PIN instead of a password.
        </p>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "#78828c" }}>Loading…</div>
      ) : passkeys.length === 0 ? (
        <div
          style={{
            background: "#f5f6f7",
            border: "1px solid #e0e0e0",
            borderRadius: 4,
            padding: "12px 14px",
            fontSize: 13,
            color: "#78828c",
            marginBottom: 12,
          }}
        >
          No passkeys registered on this account.
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {passkeys.map(pk => (
            <div
              key={pk.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                border: "1px solid #e0e0e0",
                borderRadius: 4,
                background: "#fff",
                marginBottom: 6,
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === pk.id ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleRename(pk.id); if (e.key === "Escape") setEditingId(null); }}
                      autoFocus
                      style={{
                        height: 28, padding: "0 8px", border: "1px solid #1976d2",
                        borderRadius: 4, fontSize: 13, outline: "none", width: 160,
                      }}
                    />
                    <button onClick={() => handleRename(pk.id)} style={{ ...primaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ ...secondaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#2a2b3c" }}>{pk.friendly_name}</span>
                    {pk.device_type === "multiDevice" && pk.backed_up && (
                      <span style={{ fontSize: 11, background: "#e3f2fd", color: "#1565c0", border: "1px solid #bbdefb", borderRadius: 20, padding: "1px 6px", fontWeight: 600 }}>
                        Cloud
                      </span>
                    )}
                    <button
                      onClick={() => { setEditingId(pk.id); setEditName(pk.friendly_name); }}
                      style={{ background: "none", border: "none", color: "#78828c", cursor: "pointer", fontSize: 12, padding: "0 2px" }}
                    >
                      Rename
                    </button>
                  </div>
                )}
                <div style={{ fontSize: 11, color: "#78828c", marginTop: 2 }}>
                  Added {formatDate(pk.created_at)} · Last used {formatDate(pk.last_used_at)}
                </div>
              </div>
              <button
                onClick={() => handleDelete(pk.id)}
                disabled={deletingId === pk.id}
                style={{
                  background: "none",
                  border: "1px solid #ffcdd2",
                  borderRadius: 4,
                  color: "#c62828",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "4px 10px",
                  flexShrink: 0,
                  opacity: deletingId === pk.id ? 0.5 : 1,
                }}
              >
                {deletingId === pk.id ? "Removing…" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      {addError && (
        <div style={{ fontSize: 13, color: "#c62828", marginBottom: 10 }}>{addError}</div>
      )}
      {addSuccess && (
        <div style={{ fontSize: 13, color: "#2e7d32", marginBottom: 10 }}>Passkey added successfully.</div>
      )}

      {supported ? (
        <button onClick={handleAdd} disabled={adding} style={{ ...primaryBtn, opacity: adding ? 0.6 : 1 }}>
          {adding ? "Waiting for device…" : passkeys.length === 0 ? "+ Add Passkey" : "+ Add Another Passkey"}
        </button>
      ) : (
        <p style={{ fontSize: 12, color: "#78828c", margin: 0 }}>
          Passkeys require a device with Face ID, Touch ID, or a PIN. Not supported in this browser.
        </p>
      )}
    </div>
  );
}

// ── Shipping Address Tab ─────────────────────────────────────────────────────

function ShippingTab({ dealer, canEdit }: { dealer: DealerRow; canEdit: boolean }) {
  const [form, setForm] = useState({
    shipping_name: dealer.shipping_name ?? "",
    shipping_attention: dealer.shipping_attention ?? "",
    shipping_address: dealer.shipping_address ?? "",
    shipping_address2: dealer.shipping_address2 ?? "",
    shipping_city: dealer.shipping_city ?? "",
    shipping_state: dealer.shipping_state ?? "",
    shipping_zip: dealer.shipping_zip ?? "",
    shipping_country: dealer.shipping_country ?? "US",
    shipping_phone: dealer.shipping_phone ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  function copyFromInfo() {
    setForm({
      shipping_name: dealer.name ?? "",
      shipping_attention: dealer.primary_contact ?? "",
      shipping_address: dealer.address ?? "",
      shipping_address2: "",
      shipping_city: dealer.city ?? "",
      shipping_state: dealer.state ?? "",
      shipping_zip: dealer.zip ?? "",
      shipping_country: dealer.country ?? "US",
      shipping_phone: dealer.phone ?? "",
    });
  }

  async function handleSave() {
    setSaving(true);
    setSuccess(false);
    setError("");
    try {
      const res = await fetch(`/api/dealers/${dealer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ fontSize: 13, color: "#78828c", marginBottom: 16 }}>
        This address is used for label orders. If different from your dealership address,
        update it here.
      </p>

      {canEdit && (
        <button onClick={copyFromInfo} style={{ ...secondaryBtn, marginBottom: 20 }}>
          Copy from Dealership Info
        </button>
      )}

      <div style={rowStyle}>
        <Field label="Ship-to Name" value={form.shipping_name} onChange={set("shipping_name")} disabled={!canEdit} />
        <Field label="Attention" value={form.shipping_attention} onChange={set("shipping_attention")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="Address" value={form.shipping_address} onChange={set("shipping_address")} disabled={!canEdit} />
        <Field label="Suite / Unit" value={form.shipping_address2} onChange={set("shipping_address2")} disabled={!canEdit} />
      </div>
      <div style={rowStyle}>
        <Field label="City" value={form.shipping_city} onChange={set("shipping_city")} disabled={!canEdit} />
        <Field label="State" value={form.shipping_state} onChange={set("shipping_state")} disabled={!canEdit} style={{ maxWidth: 80 }} />
        <Field label="Zip" value={form.shipping_zip} onChange={set("shipping_zip")} disabled={!canEdit} style={{ maxWidth: 100 }} />
      </div>
      <div style={rowStyle}>
        <Field label="Phone" value={form.shipping_phone} onChange={set("shipping_phone")} disabled={!canEdit} />
        <Field label="Country" value={form.shipping_country} onChange={set("shipping_country")} disabled={!canEdit} style={{ maxWidth: 80 }} />
      </div>

      {canEdit && (
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? "Saving…" : "Save Shipping Address"}
          </button>
          {success && <span style={{ fontSize: 13, color: "#4caf50" }}>Saved</span>}
          {error && <span style={{ fontSize: 13, color: "#ff5252" }}>{error}</span>}
        </div>
      )}
    </div>
  );
}

// ── Order Labels Tab ─────────────────────────────────────────────────────────

type CartItem = {
  product: LabelProduct;
  optionIdx: number;
};

function OrderLabelsTab({
  dealer,
  canEdit,
  userEmail,
  userName,
}: {
  dealer: DealerRow;
  canEdit: boolean;
  userEmail: string;
  userName: string;
}) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [shipOverride, setShipOverride] = useState(false);
  const [shipForm, setShipForm] = useState({
    name: dealer.shipping_name || dealer.name || "",
    attention: dealer.shipping_attention || "",
    address1: dealer.shipping_address || dealer.address || "",
    address2: dealer.shipping_address2 || "",
    city: dealer.shipping_city || dealer.city || "",
    state: dealer.shipping_state || dealer.state || "",
    zip: dealer.shipping_zip || dealer.zip || "",
    country: dealer.shipping_country || dealer.country || "US",
    phone: dealer.shipping_phone || dealer.phone || "",
  });
  const [placing, setPlacing] = useState(false);
  const [orderResult, setOrderResult] = useState<{
    success: boolean;
    orderId?: string;
    message: string;
  } | null>(null);

  const setShip = (k: keyof typeof shipForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setShipForm(prev => ({ ...prev, [k]: e.target.value }));

  function toggleOption(product: LabelProduct, optionIdx: number) {
    setCart(prev => {
      const existing = prev.find(c => c.product.sku === product.sku);
      if (existing) {
        if (existing.optionIdx === optionIdx) {
          return prev.filter(c => c.product.sku !== product.sku);
        }
        return prev.map(c => c.product.sku === product.sku ? { ...c, optionIdx } : c);
      }
      return [...prev, { product, optionIdx }];
    });
  }

  function isSelected(sku: string, idx: number) {
    return cart.some(c => c.product.sku === sku && c.optionIdx === idx);
  }

  const cartTotal = cart.reduce((s, c) => s + c.product.options[c.optionIdx].price, 0);

  async function placeOrder() {
    if (cart.length === 0) return;
    setPlacing(true);
    setOrderResult(null);

    const items = cart.map(c => ({
      sku: c.product.sku,
      qty: c.product.options[c.optionIdx].qty,
      price: c.product.options[c.optionIdx].price,
      shipping: c.product.options[c.optionIdx].shipping,
      productName: c.product.name,
    }));

    const shipTo = {
      name: shipForm.name,
      attention: shipForm.attention || undefined,
      address1: shipForm.address1,
      address2: shipForm.address2 || undefined,
      city: shipForm.city,
      state: shipForm.state,
      zip: shipForm.zip,
      country: shipForm.country || "US",
      phone: shipForm.phone || undefined,
    };

    try {
      const res = await fetch("/api/orders/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          shipTo,
          dealerId: dealer.id,
          dealerName: dealer.name,
          internalDealerId: dealer.internal_id ?? dealer.dealer_id,
          orderedByName: userName,
          orderedByEmail: userEmail,
        }),
      });
      const data = await res.json() as { success: boolean; orderId?: string; message: string };
      setOrderResult(data);
      if (data.success) setCart([]);
    } catch {
      setOrderResult({ success: false, message: "Network error — please try again." });
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div>
      {!canEdit && (
        <div
          style={{
            background: "#fff8e1",
            border: "1px solid #ffa500",
            borderRadius: 4,
            padding: "10px 14px",
            marginBottom: 20,
            fontSize: 13,
            color: "#555",
          }}
        >
          Label orders require Dealer Admin access. Contact your dealer administrator to place an order.
        </div>
      )}

      {/* Product grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
          marginBottom: 28,
        }}
      >
        {LABEL_PRODUCTS.map(product => {
          const selectedItem = cart.find(c => c.product.sku === product.sku);
          return (
            <div
              key={product.sku}
              style={{
                background: "#fff",
                border: selectedItem ? "2px solid #1976d2" : "1px solid #e0e0e0",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "12px 14px 8px",
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, color: "#2a2b3c", marginBottom: 2 }}>
                  {product.name}
                </div>
                <div style={{ fontSize: 12, color: "#78828c" }}>{product.size}</div>
              </div>
              <div style={{ padding: "8px 14px 12px" }}>
                {product.options.map((opt, idx) => {
                  const sel = isSelected(product.sku, idx);
                  return (
                    <button
                      key={idx}
                      onClick={() => canEdit && toggleOption(product, idx)}
                      disabled={!canEdit}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "6px 8px",
                        marginBottom: 4,
                        borderRadius: 4,
                        border: sel ? "1px solid #1976d2" : "1px solid #e0e0e0",
                        background: sel ? "#e3f2fd" : "#fafafa",
                        cursor: canEdit ? "pointer" : "default",
                        fontSize: 13,
                        color: "#333",
                        textAlign: "left",
                      }}
                    >
                      <span>
                        {opt.qty.toLocaleString()} labels
                        {opt.shipping === "fedex" && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              background: "#fff3e0",
                              color: "#e65100",
                              border: "1px solid #ffcc02",
                              borderRadius: 3,
                              padding: "1px 4px",
                              fontWeight: 600,
                            }}
                          >
                            FedEx
                          </span>
                        )}
                      </span>
                      <span style={{ fontWeight: 600, color: "#1976d2", fontFamily: "monospace" }}>
                        ${opt.price.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Ship-to block */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: "16px 20px",
          marginBottom: 20,
          maxWidth: 560,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c", margin: 0 }}>
            Ship To
          </h3>
          {canEdit && (
            <button
              onClick={() => setShipOverride(v => !v)}
              style={{ ...secondaryBtn, fontSize: 12, padding: "4px 10px", height: "auto" }}
            >
              {shipOverride ? "Use saved address" : "Edit address"}
            </button>
          )}
        </div>

        {!shipOverride ? (
          <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.8 }}>
            {shipForm.attention && <div>Attn: {shipForm.attention}</div>}
            <div>{shipForm.name}</div>
            <div>{shipForm.address1}{shipForm.address2 ? `, ${shipForm.address2}` : ""}</div>
            <div>{shipForm.city}, {shipForm.state} {shipForm.zip}</div>
            <div>{shipForm.country}</div>
            {shipForm.phone && <div>{shipForm.phone}</div>}
            {!shipForm.address1 && (
              <div style={{ color: "#ff5252", fontSize: 12 }}>
                No shipping address on file. Click &quot;Edit address&quot; to add one.
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={rowStyle}>
              <Field label="Name" value={shipForm.name} onChange={setShip("name")} />
              <Field label="Attention" value={shipForm.attention} onChange={setShip("attention")} />
            </div>
            <div style={rowStyle}>
              <Field label="Address" value={shipForm.address1} onChange={setShip("address1")} />
              <Field label="Suite / Unit" value={shipForm.address2} onChange={setShip("address2")} />
            </div>
            <div style={rowStyle}>
              <Field label="City" value={shipForm.city} onChange={setShip("city")} />
              <Field label="State" value={shipForm.state} onChange={setShip("state")} style={{ maxWidth: 80 }} />
              <Field label="Zip" value={shipForm.zip} onChange={setShip("zip")} style={{ maxWidth: 100 }} />
            </div>
            <div style={rowStyle}>
              <Field label="Phone" value={shipForm.phone} onChange={setShip("phone")} />
              <Field label="Country" value={shipForm.country} onChange={setShip("country")} style={{ maxWidth: 80 }} />
            </div>
          </div>
        )}
      </div>

      {/* Order summary + place order */}
      {canEdit && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            padding: "16px 20px",
            maxWidth: 560,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c", marginBottom: 12, margin: "0 0 12px" }}>
            Order Summary
          </h3>
          {cart.length === 0 ? (
            <p style={{ fontSize: 13, color: "#78828c" }}>
              Select label options above to build your order.
            </p>
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
                <thead>
                  <tr style={{ background: "#f5f6f7" }}>
                    <th style={thStyle}>Product</th>
                    <th style={thStyle}>Qty</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map(c => (
                    <tr key={c.product.sku} style={{ borderBottom: "1px solid #e0e0e0" }}>
                      <td style={tdStyle}>
                        {c.product.name}
                        {c.product.options[c.optionIdx].shipping === "fedex" && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              background: "#fff3e0",
                              color: "#e65100",
                              border: "1px solid #ffcc02",
                              borderRadius: 3,
                              padding: "1px 4px",
                              fontWeight: 600,
                            }}
                          >
                            FedEx
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{c.product.options[c.optionIdx].qty.toLocaleString()}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: "#1976d2" }}>
                        ${c.product.options[c.optionIdx].price.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: "#f5f6f7", fontWeight: 700 }}>
                    <td colSpan={2} style={{ ...tdStyle, textAlign: "right" }}>Total</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace" }}>
                      ${cartTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tbody>
              </table>

              <button
                onClick={placeOrder}
                disabled={placing || cart.length === 0 || !shipForm.address1}
                style={{ ...primaryBtn, opacity: (placing || !shipForm.address1) ? 0.6 : 1 }}
              >
                {placing ? "Placing order…" : "Place Order"}
              </button>

              {!shipForm.address1 && (
                <div style={{ fontSize: 12, color: "#ff5252", marginTop: 8 }}>
                  A shipping address is required before placing an order.
                </div>
              )}
            </>
          )}

          {orderResult && (
            <div
              style={{
                marginTop: 16,
                padding: "12px 14px",
                borderRadius: 4,
                border: `1px solid ${orderResult.success ? "#4caf50" : "#ff5252"}`,
                background: orderResult.success ? "#e8f5e9" : "#ffebee",
                fontSize: 13,
                color: orderResult.success ? "#2e7d32" : "#c62828",
              }}
            >
              {orderResult.success ? "✓ " : "✕ "}
              {orderResult.message}
              {orderResult.orderId && (
                <div style={{ fontSize: 11, marginTop: 4, color: "#78828c" }}>
                  Order ID: {orderResult.orderId}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Billing Stub Tab ─────────────────────────────────────────────────────────

function BillingTab() {
  return (
    <div>
      <div
        style={{
          border: "1px solid #2a2b3c",
          borderRadius: 6,
          padding: "28px 24px",
          maxWidth: 480,
          background: "#fff",
        }}
      >
        <div
          style={{
            fontWeight: 600,
            fontSize: 15,
            color: "#2a2b3c",
            marginBottom: 8,
          }}
        >
          Invoices &amp; Billing
        </div>
        <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
          Full invoice history and billing management will be available in Phase 10.
          Your billing status and invoices will appear here once the billing module launches.
        </p>
      </div>
    </div>
  );
}

// ── Shared field component ────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  disabled,
  style,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, ...style }}>
      <label style={labelStyle}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={onChange}
        disabled={disabled}
        style={{
          display: "block",
          width: "100%",
          height: 36,
          padding: "0 10px",
          border: "1px solid #e0e0e0",
          borderRadius: 4,
          fontSize: 14,
          color: "#333",
          background: disabled ? "#f5f6f7" : "#fff",
          boxSizing: "border-box",
          outline: "none",
        }}
      />
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: "#78828c",
  marginBottom: 4,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 14,
};

const primaryBtn: React.CSSProperties = {
  background: "#1976d2",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  height: 36,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  color: "#1976d2",
  border: "1px solid #1976d2",
  borderRadius: 4,
  height: 36,
  padding: "0 14px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".05em",
  color: "#78828c",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 13,
  color: "#333",
};

// ── Main export ───────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "Dealership Info" },
  { id: "shipping", label: "Shipping Address" },
  { id: "labels", label: "Order Labels" },
  { id: "billing", label: "Invoices & Billing" },
];

export default function ProfileClient({ dealer, canEdit, userEmail, userName }: Props) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get("tab");
    return (t === "labels" || t === "info" || t === "shipping" || t === "billing") ? t : "info";
  });

  return (
    <div>
      <PageHeader title={dealer.name} />

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "2px solid #e0e0e0",
          marginBottom: 24,
          background: "#fff",
          borderRadius: "6px 6px 0 0",
          overflow: "hidden",
        }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "10px 20px",
              fontSize: 13,
              fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? "#1976d2" : "#55595c",
              background: "transparent",
              border: "none",
              borderBottom: tab === t.id ? "2px solid #1976d2" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -2,
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: "0 0 6px 6px",
          padding: "24px",
        }}
      >
        {tab === "info" && <InfoTab dealer={dealer} canEdit={canEdit} />}
        {tab === "shipping" && <ShippingTab dealer={dealer} canEdit={canEdit} />}
        {tab === "labels" && (
          <OrderLabelsTab
            dealer={dealer}
            canEdit={canEdit}
            userEmail={userEmail}
            userName={userName}
          />
        )}
        {tab === "billing" && <BillingTab />}
      </div>
    </div>
  );
}
