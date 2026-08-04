import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { CustomField, CustomTextArea } from "../components/common/CustomField";
import { CustomSelect } from "../components/common/CustomSelect";
import { LoadingPanel } from "../components/common/LoadingPanel";
import { PageHeader } from "../components/common/PageHeader";
import { listPlatformConnections } from "../features/platformConnections/api/platformConnectionApi";
import {
  createProduct,
  deleteProduct,
  listProducts,
  setProductAvailability,
  updateProduct,
  uploadProductImage,
} from "../features/products/api/productsApi";
import type { Product } from "../features/products/api/productsApi";
import type { PlatformConnection } from "../shared/types/platformConnection";

type ProductFormState = {
  name: string;
  description: string;
  price: string;
  currency: string;
  price_text: string;
  category: string;
};

type UploadEntry = {
  id: number;
  fileName: string;
  status: "uploading" | "done" | "error";
  url?: string;
};

const EMPTY_FORM: ProductFormState = {
  name: "",
  description: "",
  price: "",
  currency: "",
  price_text: "",
  category: "",
};

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { response?: { data?: { detail?: unknown } }; message?: unknown };
    const detail = candidate.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return "Something went wrong.";
}

function formatPrice(product: Product): string | null {
  if (product.price_text?.trim()) return product.price_text.trim();
  if (product.price == null || product.price === "") return null;
  const currency = product.currency?.trim();
  return currency ? `${currency} ${product.price}`.trim() : product.price;
}

export function ProductsPage() {
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM);
  const [images, setImages] = useState<string[]>([]);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [saving, setSaving] = useState(false);

  const modalSessionRef = useRef(0);
  const uploadSequenceIdRef = useRef(0);

  const refreshProducts = useCallback(() => setRefreshKey((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoadingConnections(true);

    listPlatformConnections()
      .then((response) => {
        if (cancelled) return;
        const pages = response.items.filter(
          (connection) => connection.platform_type === "facebook_page" && connection.status === "connected",
        );
        setConnections(pages);
        setSelectedConnectionId((current) => {
          if (pages.some((connection) => connection.id === Number(current))) return current;
          return pages[0] ? String(pages[0].id) : "";
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(extractErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingConnections(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const connectionId = selectedConnectionId ? Number(selectedConnectionId) : null;
    if (!connectionId) {
      setProducts([]);
      setLoadingProducts(false);
      return;
    }

    let cancelled = false;
    setLoadingProducts(true);
    setError(null);

    listProducts({ connection_id: connectionId })
      .then((items) => {
        if (!cancelled) setProducts(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(extractErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedConnectionId, refreshKey]);

  const beginModalSession = () => {
    modalSessionRef.current += 1;
    return modalSessionRef.current;
  };

  const openCreateModal = () => {
    beginModalSession();
    setEditing(null);
    setForm(EMPTY_FORM);
    setImages([]);
    setUploads([]);
    setUrlInput("");
    setModalOpen(true);
  };

  const openEditModal = (product: Product) => {
    beginModalSession();
    setEditing(product);
    setForm({
      name: product.name,
      description: product.description ?? "",
      price: product.price ?? "",
      currency: product.currency ?? "",
      price_text: product.price_text ?? "",
      category: product.category ?? "",
    });
    setImages(product.images);
    setUploads([]);
    setUrlInput("");
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedConnectionId) return;

    const payload = {
      name: form.name.trim(),
      platform_connection_id: Number(selectedConnectionId),
      images,
      description: form.description.trim() ? form.description.trim() : null,
      price: form.price.trim() === "" ? null : Number(form.price),
      currency: form.currency.trim() ? form.currency.trim() : null,
      price_text: form.price_text.trim() ? form.price_text.trim() : null,
      category: form.category.trim() ? form.category.trim() : null,
    };

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (editing) {
        await updateProduct(editing.id, payload);
        setMessage("Product updated.");
      } else {
        await createProduct(payload);
        setMessage("Product created.");
      }
      setModalOpen(false);
      setEditing(null);
      refreshProducts();
    } catch (err: unknown) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAvailability = async (product: Product) => {
    setTogglingId(product.id);
    setError(null);
    setMessage(null);
    try {
      await setProductAvailability(product.id, !product.is_available);
      setMessage(product.is_available ? "Product marked out of stock." : "Product marked available.");
      refreshProducts();
    } catch (err: unknown) {
      setError(extractErrorMessage(err));
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (product: Product) => {
    if (!window.confirm(`Delete product "${product.name}"? This cannot be undone.`)) {
      return;
    }
    setDeletingId(product.id);
    setError(null);
    setMessage(null);
    try {
      await deleteProduct(product.id);
      setMessage("Product deleted.");
      refreshProducts();
    } catch (err: unknown) {
      setError(extractErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    const session = beginModalSession();
    for (const file of files) {
      const entryId = ++uploadSequenceIdRef.current;
      setUploads((current) => [...current, { id: entryId, fileName: file.name, status: "uploading" }]);
      try {
        const { url } = await uploadProductImage(file);
        if (modalSessionRef.current !== session) return;
        setUploads((current) =>
          current.map((entry) => (entry.id === entryId ? { ...entry, status: "done", url } : entry)),
        );
        setImages((current) => (current.includes(url) ? current : [...current, url]));
      } catch (err: unknown) {
        if (modalSessionRef.current !== session) return;
        setUploads((current) =>
          current.map((entry) => (entry.id === entryId ? { ...entry, status: "error" } : entry)),
        );
      }
    }
  };

  const handleAddImageUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    setImages((current) => (current.includes(url) ? current : [...current, url]));
    setUrlInput("");
  };

  const removeImage = (url: string) => {
    setImages((current) => current.filter((item) => item !== url));
    setUploads((current) => current.filter((entry) => entry.url !== url));
  };

  const selectedConnection = connections.find((connection) => connection.id === Number(selectedConnectionId)) ?? null;
  const uploadingCount = uploads.filter((entry) => entry.status === "uploading").length;
  const canSubmit = Boolean(selectedConnectionId) && form.name.trim() !== "" && uploadingCount === 0;

  return (
    <section>
      <PageHeader
        eyebrow="Products"
        title="Product catalog"
        description="Manage the products each Facebook Page sells. The AI agent references this catalog when answering customer questions."
      />

      {message ? <div className="panel success-panel">{message}</div> : null}
      {error ? <div className="panel error-panel">{error}</div> : null}

      <div className="products-toolbar">
        <label className="products-page-select">
          Facebook Page
          <CustomSelect
            value={selectedConnectionId}
            onChange={setSelectedConnectionId}
            disabled={loadingConnections}
            placeholder="Select a Facebook Page"
            options={connections.map((connection) => ({
              value: String(connection.id),
              label: connection.name,
              helper: connection.external_name || connection.external_id || undefined,
            }))}
          />
        </label>
        <button
          type="button"
          className="ghost-button compact-button products-add-button"
          onClick={openCreateModal}
          disabled={!selectedConnectionId}
        >
          Add product
        </button>
      </div>

      {loadingConnections ? (
        <LoadingPanel message="Loading Facebook Pages..." hint="Fetching connected pages for the active workspace." compact />
      ) : connections.length === 0 ? (
        <div className="panel products-empty">
          <strong>No connected Facebook Pages yet</strong>
          <p className="muted-copy">
            Connect a Facebook Page under Channels first, then come back to build its product catalog.
          </p>
        </div>
      ) : !selectedConnection ? (
        <div className="panel products-empty">
          <strong>Select a Facebook Page</strong>
          <p className="muted-copy">Pick a page above to view and manage its product catalog.</p>
        </div>
      ) : loadingProducts ? (
        <LoadingPanel message="Loading products..." hint={`Fetching the catalog for ${selectedConnection.name}.`} compact />
      ) : products.length === 0 ? (
        <div className="panel products-empty">
          <strong>No products yet</strong>
          <p className="muted-copy">
            Add the first product to {selectedConnection.name}&apos;s catalog so the AI agent can reference it when replying.
          </p>
        </div>
      ) : (
        <div className="products-grid">
          {products.map((product) => {
            const firstImage = product.images[0] ?? null;
            return (
              <article className="product-card" key={product.id}>
                <div className="product-card-media">
                  {firstImage ? (
                    <img src={firstImage} alt={product.name} loading="lazy" />
                  ) : (
                    <div className="product-card-placeholder">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="m21 15-5-5L5 21" />
                      </svg>
                      <span>No image yet</span>
                    </div>
                  )}
                  {product.images.length > 1 ? (
                    <span className="product-card-count">{product.images.length} photos</span>
                  ) : null}
                </div>
                <div className="product-card-body">
                  <h3>{product.name}</h3>
                  <p className="product-card-price">{formatPrice(product) ?? "—"}</p>
                  <div className="product-card-meta">
                    {product.category ? <p className="product-card-category">{product.category}</p> : null}
                    <span className={`status-pill ${product.is_available ? "status-active" : "status-disabled"}`}>
                      {product.is_available ? "Available" : "Out of stock"}
                    </span>
                  </div>
                  {product.description ? <p className="muted-copy small-copy">{product.description}</p> : null}
                </div>
                <div className="product-card-actions">
                  <button
                    type="button"
                    className={`ai-toggle-btn product-card-availability-toggle ${product.is_available ? "enabled" : ""}`.trim()}
                    disabled={togglingId === product.id}
                    onClick={() => void handleToggleAvailability(product)}
                  >
                    {togglingId === product.id
                      ? "Updating..."
                      : product.is_available
                        ? "Mark out of stock"
                        : "Mark available"}
                  </button>
                  <button type="button" className="link-button" onClick={() => openEditModal(product)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="link-button danger-link"
                    disabled={deletingId === product.id}
                    onClick={() => void handleDelete(product)}
                  >
                    {deletingId === product.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {modalOpen ? (
        <div className="dialog-backdrop" role="presentation" onClick={closeModal}>
          <div
            className="dialog-card product-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "Edit product" : "Add product"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <div>
                <h3>{editing ? "Edit product" : "Add product"}</h3>
                <p className="muted-copy">
                  The AI agent uses this catalog when answering customer questions about your products.
                </p>
              </div>
              <button type="button" className="ghost-button compact-button" onClick={closeModal}>
                Close
              </button>
            </div>

            <div className="product-dialog-body">
              <form className="panel form-panel product-form" onSubmit={handleSubmit}>
                <label>
                  Name
                  <CustomField
                    value={form.name}
                    required
                    placeholder="e.g. Summer Kurta Set"
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label>
                  Category
                  <CustomField
                    value={form.category}
                    placeholder="e.g. Women, Clothing"
                    onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                  />
                </label>
                <label className="field-full">
                  Description
                  <CustomTextArea
                    value={form.description}
                    rows={3}
                    placeholder="Fabric, sizes, key selling points — anything the AI should know."
                    onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </label>
                <label>
                  Price
                  <CustomField
                    value={form.price}
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="e.g. 1490"
                    onChange={(event) => setForm((current) => ({ ...current, price: event.target.value }))}
                  />
                </label>
                <label>
                  Currency
                  <CustomField
                    value={form.currency}
                    maxLength={8}
                    placeholder="e.g. BDT, USD"
                    onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value }))}
                  />
                </label>
                <label className="field-full">
                  Price label (optional)
                  <CustomField
                    value={form.price_text}
                    placeholder="Overrides currency + price, e.g. ৳1,490 (special offer)"
                    onChange={(event) => setForm((current) => ({ ...current, price_text: event.target.value }))}
                  />
                </label>

                <div className="field-full product-images-picker">
                  <div className="product-images-picker-head">
                    <strong>Photos</strong>
                    <span className="product-images-picker-note">{images.length} image(s)</span>
                  </div>
                  <label>
                    Upload photos
                    <input type="file" accept="image/*" multiple onChange={(event) => void handleFilesSelected(event)} />
                  </label>
                  <div className="product-upload-url-row">
                    <label>
                      Or paste an image URL
                      <CustomField
                        value={urlInput}
                        placeholder="https://..."
                        onChange={(event) => setUrlInput(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-action product-upload-url-add"
                      onClick={handleAddImageUrl}
                      disabled={!urlInput.trim()}
                    >
                      Add URL
                    </button>
                  </div>
                  {uploads.length > 0 ? (
                    <div className="product-upload-list">
                      {uploads.map((entry) => (
                        <div key={entry.id} className={`product-upload-entry ${entry.status}`.trim()}>
                          <span className="product-upload-entry-name">{entry.fileName}</span>
                          <span className="product-upload-entry-status">
                            {entry.status === "uploading" ? "Uploading..." : entry.status === "done" ? "Uploaded" : "Failed"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {images.length > 0 ? (
                    <div className="product-thumbnail-list">
                      {images.map((url) => (
                        <div className="product-thumbnail" key={url}>
                          <img src={url} alt="Product preview" />
                          <button
                            type="button"
                            className="secondary-action product-thumbnail-remove"
                            aria-label="Remove image"
                            onClick={() => removeImage(url)}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="form-action-row">
                  <button type="submit" className="form-primary-button" disabled={!canSubmit || saving}>
                    {saving ? "Saving..." : editing ? "Save changes" : "Add product"}
                  </button>
                  <button type="button" className="secondary-action form-cancel-button" onClick={closeModal} disabled={saving}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
