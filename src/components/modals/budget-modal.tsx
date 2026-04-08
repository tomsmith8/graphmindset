"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Zap, Copy, Check, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useModalStore } from "@/stores/modal-store"
import { useUserStore } from "@/stores/user-store"
import { isSphinx, getL402, hasWebLN, payL402, topUpLsat, topUpConfirm } from "@/lib/sphinx"
import { api } from "@/lib/api"

type TopUpStatus = "idle" | "generating" | "awaiting_payment" | "success"

export function BudgetModal() {
  const { activeModal, close } = useModalStore()
  const { budget, setBudget } = useUserStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  // Manual top-up state
  const [topUpAmount, setTopUpAmount] = useState<number | "">("")
  const [topUpStatus, setTopUpStatus] = useState<TopUpStatus>("idle")
  const [paymentRequest, setPaymentRequest] = useState("")
  const [paymentHash, setPaymentHash] = useState("")
  const [copied, setCopied] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const previousBalanceRef = useRef(0)

  const sphinxConnected = typeof window !== "undefined" && isSphinx()
  const weblnAvailable = typeof window !== "undefined" && hasWebLN()

  const hasExistingL402 =
    typeof window !== "undefined" && !!localStorage.getItem("l402")

  const formattedBudget =
    budget !== null && budget !== undefined
      ? budget.toLocaleString()
      : "--"

  // Clean up polling on close/unmount
  useEffect(() => {
    if (activeModal !== "budget") {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setTopUpStatus("idle")
      setTopUpAmount("")
      setPaymentRequest("")
      setPaymentHash("")
      setCopied(false)
    }
  }, [activeModal])

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  // Top up via Sphinx bridge (L402 flow)
  const handleSphinxTopUp = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      localStorage.removeItem("l402")
      const l402 = await getL402()
      if (!l402) {
        setError("Payment was not completed.")
        return
      }
      const balance = await api.get<{ balance: number }>("/balance", {
        Authorization: l402,
      })
      setBudget(balance.balance)
    } catch {
      setError("Failed to process payment. Try again.")
    } finally {
      setLoading(false)
    }
  }, [setBudget])

  // Top up via WebLN (browser extension like Alby)
  const handleWebLNTopUp = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      await payL402(setBudget)

      // Refresh balance after successful payment
      const l402 = await getL402()
      if (l402) {
        const balance = await api.get<{ balance: number }>("/balance", {
          Authorization: l402,
        })
        setBudget(balance.balance)
      }
    } catch {
      setError("Payment was cancelled or failed.")
    } finally {
      setLoading(false)
    }
  }, [setBudget])

  // Manual invoice top-up
  const handleGenerateInvoice = useCallback(async () => {
    const amount = Number(topUpAmount)
    if (!amount || amount < 1 || amount > 10000) {
      setError("Amount must be between 1 and 10,000 sats.")
      return
    }

    const stored = localStorage.getItem("l402")
    if (!stored) {
      setError("No existing L402 token. Use Sphinx or WebLN first.")
      return
    }

    const { macaroon } = JSON.parse(stored)
    setError("")
    setTopUpStatus("generating")

    try {
      const result = await topUpLsat(macaroon, amount)
      setPaymentRequest(result.payment_request)
      setPaymentHash(result.payment_hash)
      setTopUpStatus("awaiting_payment")
      previousBalanceRef.current = budget ?? 0

      // Poll balance every 3 seconds
      const l402Token = await getL402()
      intervalRef.current = setInterval(async () => {
        try {
          const bal = await api.get<{ balance: number }>("/balance", {
            Authorization: l402Token,
          })
          if (bal.balance > previousBalanceRef.current) {
            if (intervalRef.current) clearInterval(intervalRef.current)
            await topUpConfirm(result.payment_hash, macaroon)
            setBudget(bal.balance)
            setTopUpStatus("success")
          }
        } catch {
          // ignore polling errors
        }
      }, 3000)
    } catch {
      setError("Failed to generate invoice. Try again.")
      setTopUpStatus("idle")
    }
  }, [topUpAmount, budget, setBudget])

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(paymentRequest)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [paymentRequest])

  const handleRefreshBalance = useCallback(async () => {
    setLoading(true)
    try {
      const l402 = await getL402()
      if (!l402) {
        setBudget(0)
        return
      }
      const balance = await api.get<{ balance: number }>("/balance", {
        Authorization: l402,
      })
      setBudget(balance.balance)
    } catch {
      // keep existing budget
    } finally {
      setLoading(false)
    }
  }, [setBudget])

  const canTopUp = sphinxConnected || weblnAvailable

  return (
    <Dialog open={activeModal === "budget"} onOpenChange={() => close()}>
      <DialogContent className="border-border/50 bg-card noise-bg sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg tracking-wide">
            Budget
          </DialogTitle>
          <DialogDescription>
            Manage your Lightning L402 balance.
          </DialogDescription>
        </DialogHeader>

        <div className="relative z-10 space-y-5 pt-2">
          {/* Balance display */}
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border/50 bg-muted/30 p-6">
            <Zap className="h-6 w-6 text-amber glow-text-amber" />
            <div className="text-center">
              <p className="text-3xl font-heading font-bold tracking-tight text-foreground">
                {formattedBudget}
              </p>
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mt-1">
                satoshis
              </p>
            </div>
          </div>

          {/* Connection status */}
          <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/20 px-3 py-2.5">
            <div
              className={`h-2 w-2 rounded-full ${
                canTopUp
                  ? "bg-emerald-400 shadow-[0_0_4px_theme(colors.emerald.400)]"
                  : "bg-muted-foreground/40"
              }`}
            />
            <span className="text-xs text-muted-foreground">
              {sphinxConnected
                ? "Connected via Sphinx"
                : weblnAvailable
                  ? "WebLN detected (Alby, etc.)"
                  : "No Lightning wallet detected"}
            </span>
          </div>

          {error && (
            <p className="text-xs text-destructive text-center">{error}</p>
          )}

          <Separator className="bg-border/30" />

          {/* Actions */}
          <div className="flex flex-col gap-2">
            {sphinxConnected && (
              <Button
                onClick={handleSphinxTopUp}
                disabled={loading}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 text-xs"
              >
                <Zap className="mr-2 h-3.5 w-3.5" />
                {loading ? "Processing..." : "Top Up via Sphinx"}
              </Button>
            )}

            {weblnAvailable && !sphinxConnected && (
              <Button
                onClick={handleWebLNTopUp}
                disabled={loading}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 text-xs"
              >
                <Zap className="mr-2 h-3.5 w-3.5" />
                {loading ? "Processing..." : "Top Up via WebLN"}
              </Button>
            )}

            {!canTopUp && !hasExistingL402 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                Install a Lightning wallet extension (like Alby) or connect via
                the Sphinx app to top up your balance.
              </p>
            )}

            {/* Manual invoice top-up — only when L402 exists */}
            {hasExistingL402 && topUpStatus === "idle" && (
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={topUpAmount}
                  onChange={(e) =>
                    setTopUpAmount(e.target.value ? Number(e.target.value) : "")
                  }
                  placeholder="Sats (1–10,000)"
                  className="h-8 flex-1 rounded-md border border-border/50 bg-muted/50 px-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
                <Button
                  onClick={handleGenerateInvoice}
                  disabled={loading || !topUpAmount}
                  className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Zap className="mr-1.5 h-3 w-3" />
                  Invoice
                </Button>
              </div>
            )}

            {topUpStatus === "generating" && (
              <div className="flex items-center justify-center gap-2 py-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Generating invoice...
                </span>
              </div>
            )}

            {topUpStatus === "awaiting_payment" && (
              <div className="space-y-2 rounded-md border border-border/30 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  Lightning Invoice
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate text-xs font-mono text-foreground">
                    {paymentRequest.slice(0, 24)}…{paymentRequest.slice(-8)}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <div className="flex items-center gap-1.5 pt-1">
                  <Loader2 className="h-3 w-3 animate-spin text-amber" />
                  <span className="text-xs text-muted-foreground">
                    Waiting for payment...
                  </span>
                </div>
              </div>
            )}

            {topUpStatus === "success" && (
              <div className="flex items-center justify-between rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-xs text-emerald-400">
                    Top-up complete!
                  </span>
                </div>
                <button
                  onClick={() => {
                    setTopUpStatus("idle")
                    setTopUpAmount("")
                    setPaymentRequest("")
                    setPaymentHash("")
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Top up again
                </button>
              </div>
            )}

            <Button
              variant="ghost"
              onClick={handleRefreshBalance}
              disabled={loading}
              className="w-full text-xs text-muted-foreground"
            >
              Refresh Balance
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
