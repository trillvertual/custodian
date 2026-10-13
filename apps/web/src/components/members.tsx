import { Checkbox } from "./ui/checkbox";
import { PageHeader } from "./page-header";
import { Card } from "./ui/card";
import { CardHeadRow } from "./card-head-row";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./ui/table";
import { useEffect, useRef, useState } from "react";
import {
  UserPlus,
  Copy,
  ShieldCheck,
  Users,
  Check,
  Download,
  UserRoundMinus,
} from "lucide-react";
import { toast } from "sonner";
import {
  fingerprint,
  sealVaultKey,
  randomKey,
  createRecovery,
  encryptJson,
  decryptJson,
  recordContext,
  erase,
  type Member,
  type StoredRecord,
} from "../../../../packages/core/src/index.ts";
import { api, copyToClipboard, recoveryDownload } from "../lib/api";
import type { VaultStore } from "../lib/store";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ErrorMessage } from "./forms";
import { TableLoading } from "./table-loading";
export function Members({ store }: { store: VaultStore }) {
  const [members, setMembers] = useState<Member[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [invite, setInvite] = useState(""),
    [inviteOpen, setInviteOpen] = useState(false),
    [grant, setGrant] = useState<Member | null>(null),
    [grantOpen, setGrantOpen] = useState(false),
    [verified, setVerified] = useState(false),
    [revoke, setRevoke] = useState<Member | null>(null),
    [revokeOpen, setRevokeOpen] = useState(false),
    [recovery, setRecovery] = useState<{
      code: string;
      box: ReturnType<typeof createRecovery>["box"];
      key: Uint8Array;
    } | null>(null),
    [downloaded, setDownloaded] = useState(false),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    [copying, setCopying] = useState(false);
  const mutation = useRef(false);
  const mounted = useRef(true);
  const latestLoad = useRef(0);
  const user = store.session!.user;
  const load = () => {
    const request = ++latestLoad.current;
    return api<Member[]>("/members")
      .then((rows) => {
        if (!mounted.current || request !== latestLoad.current) return;
        setMembers(rows);
        setError("");
      })
      .catch((e) => {
        if (mounted.current && request === latestLoad.current)
          setError(e.message);
      })
      .finally(() => {
        if (mounted.current && request === latestLoad.current)
          setLoading(false);
      });
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      latestLoad.current += 1;
    };
  }, []);
  useEffect(
    () => () => {
      erase(recovery?.key);
    },
    [recovery],
  );
  function beginMutation() {
    if (mutation.current) return false;
    mutation.current = true;
    setBusy(true);
    return true;
  }
  function endMutation() {
    mutation.current = false;
    if (mounted.current) setBusy(false);
  }
  async function inviteMember() {
    if (!beginMutation()) return;
    try {
      const result = await api<{ url: string }>("/invites", "POST");
      if (mounted.current) {
        setInvite(result.url);
        setInviteOpen(true);
      }
    } catch (e) {
      if (mounted.current) toast.error((e as Error).message);
    } finally {
      endMutation();
    }
  }
  async function approve() {
    if (!grant || !grantOpen || !verified || !beginMutation()) return;
    try {
      await api(`/members/${grant.id}/grant`, "POST", {
        publicKey: grant.publicKey,
        sealedKey: sealVaultKey(
          store.keys.current!.vaultKey,
          grant.publicKey,
          user.vaultId,
          user.epoch,
        ),
        epoch: user.epoch,
      });
      if (!mounted.current) return;
      setGrantOpen(false);
      await load();
      toast.success("Доступ выдан.");
    } catch (e) {
      if (mounted.current) toast.error((e as Error).message);
    } finally {
      endMutation();
    }
  }
  function startRevoke(m: Member) {
    if (mutation.current) return;
    const key = randomKey();
    const rescue = createRecovery(key, user.vaultId, user.epoch + 1);
    setRecovery({ ...rescue, key });
    setDownloaded(false);
    setSaved(false);
    setRevoke(m);
    setRevokeOpen(true);
  }
  async function disable() {
    if (
      !revoke ||
      !revokeOpen ||
      !recovery ||
      !downloaded ||
      !saved ||
      !beginMutation()
    )
      return;
    const currentKeys = store.keys.current;
    try {
      if (!currentKeys) throw new Error("Хранилище заблокировано.");
      const snapshot = await api<{
        snapshot: string;
        epoch: number;
        members: Member[];
        records: StoredRecord[];
        history: StoredRecord[];
      }>("/rotation");
      if (!mounted.current || store.keys.current !== currentKeys) return;
      if (snapshot.epoch !== user.epoch)
        throw new Error("Ключ изменился. Разблокируйте хранилище заново.");
      const nextEpoch = snapshot.epoch + 1;
      const rotate = (r: StoredRecord) => ({
        id: r.id,
        version: r.version,
        box: encryptJson(
          decryptJson(
            r.box,
            currentKeys.vaultKey,
            recordContext(user.vaultId, r.id, r.version, r.epoch),
          ),
          recovery.key,
          recordContext(user.vaultId, r.id, r.version, nextEpoch),
        ),
      });
      await api("/rotation", "POST", {
        snapshot: snapshot.snapshot,
        revokeId: revoke.id,
        epoch: nextEpoch,
        recovery: recovery.box,
        keys: snapshot.members
          .filter((m) => m.status === "active" && m.id !== revoke.id)
          .map((m) => ({
            id: m.id,
            publicKey: m.publicKey,
            sealedKey: sealVaultKey(
              recovery.key,
              m.publicKey,
              user.vaultId,
              nextEpoch,
            ),
          })),
        records: snapshot.records.map(rotate),
        history: snapshot.history.map(rotate),
      });
      if (mounted.current) {
        setRevoke(null);
        setRevokeOpen(false);
        setRecovery(null);
      }
      store.lock();
      await store.refreshSession();
      toast.success("Участник отключён. Ключ хранилища обновлён.");
    } catch (e) {
      if (mounted.current) toast.error((e as Error).message);
    } finally {
      endMutation();
    }
  }
  return (
    <div className="page-body">
      <PageHeader
        title="Команда"
        actions={
          user.role === "owner" && (
            <Button size="sm" onClick={inviteMember} disabled={busy}>
              <UserPlus size={16} />
              Пригласить
            </Button>
          )
        }
      />
      <div className="notice inline-notice">
        <ShieldCheck size={17} />
        <span>
          Все активные админы могут просматривать и редактировать записи.
          Участниками управляет владелец.
        </span>
      </div>
      <ErrorMessage error={error} />
      {error && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Повторить загрузку
        </Button>
      )}
      <Card className="table-frame members-card gap-0 py-0" aria-busy={loading}>
        <CardHeadRow
          title="Участники"
          count={loading ? undefined : members.length}
        />
        <Table className="members-table">
          <TableHeader>
            <TableRow>
              <TableHead>Участник</TableHead>
              <TableHead>Роль</TableHead>
              <TableHead>Доступ</TableHead>
              <TableHead>
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableLoading columns={4} />}
            {!loading &&
              members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="member-name">
                      <div className="avatar">
                        {m.displayName.slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <strong>
                          {m.displayName}
                          {m.id === user.id && <small> · вы</small>}
                        </strong>
                        <span>@{m.username}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {m.role === "owner" ? "Владелец" : "Администратор"}
                  </TableCell>
                  <TableCell>
                    <span className={`status status-${m.status}`}>
                      {m.status === "active"
                        ? "Активен"
                        : m.status === "pending"
                          ? "Ожидает ключ"
                          : "Отключён"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {user.role === "owner" && m.role !== "owner" && (
                      <div className="row-actions">
                        {m.status === "pending" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setGrant(m);
                              setGrantOpen(true);
                              setVerified(false);
                            }}
                          >
                            <Check size={14} />
                            Выдать доступ
                          </Button>
                        )}
                        {m.status !== "suspended" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Отключить ${m.displayName}`}
                            disabled={busy}
                            onClick={() => startRevoke(m)}
                          >
                            <UserRoundMinus size={17} />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Card>
      <p className="footnote">
        <Users size={15} />
        Для восстановления потерянного доступа админ создаёт новый личный ключ.
        Владелец сверяет отпечаток и выдаёт доступ повторно.
      </p>
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!open) setInviteOpen(false);
        }}
        onExitComplete={() => setInvite("")}
        title="Приглашение в команду"
        description="Ссылка действует 24 часа и используется один раз."
      >
        <div className="invite-link">
          <input aria-label="Ссылка приглашения" value={invite} readOnly />
          <Button
            variant="outline"
            size="icon"
            aria-label="Копировать приглашение"
            disabled={copying}
            aria-busy={copying}
            onClick={async () => {
              if (copying) return;
              setCopying(true);
              try {
                await copyToClipboard(invite);
                if (mounted.current) toast.success("Ссылка скопирована.");
              } catch (e) {
                if (mounted.current) toast.error((e as Error).message);
              } finally {
                if (mounted.current) setCopying(false);
              }
            }}
          >
            <Copy size={16} />
          </Button>
        </div>
        <p className="muted">
          Передайте её админу лично. После регистрации проверьте отпечаток его
          ключа.
        </p>
      </Dialog>
      <Dialog
        open={grantOpen}
        onOpenChange={(open) => {
          if (!open && !mutation.current) setGrantOpen(false);
        }}
        onExitComplete={() => {
          setGrant(null);
          setVerified(false);
        }}
        title="Выдать ключ хранилища"
        description={`Сверьте этот отпечаток с ${grant?.displayName} через доверенный канал.`}
      >
        {grant && (
          <>
            <div className="fingerprint-box">
              <code>{fingerprint(grant.publicKey)}</code>
            </div>
            <label className="check-label">
              <Checkbox
                checked={verified}
                disabled={busy}
                onCheckedChange={(checked) => setVerified(checked === true)}
              />
              Я проверил личность и отпечаток ключа
            </label>
            <div className="dialog-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setGrantOpen(false)}
              >
                Отмена
              </Button>
              <Button disabled={!verified || busy} onClick={approve}>
                Выдать доступ
              </Button>
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={revokeOpen}
        onOpenChange={(open) => {
          if (!open && !mutation.current) setRevokeOpen(false);
        }}
        onExitComplete={() => {
          setRevoke(null);
          setRecovery(null);
        }}
        title={`Отключить ${revoke?.displayName ?? "участника"}?`}
        description="Приложение сменит ключ и перешифрует хранилище, корзину и историю."
      >
        <p>
          Скопированные ранее пароли останутся у участника. Измените их в
          соответствующих сервисах.
        </p>
        <p>
          Перед отключением сохраните новый rescue-ключ. Старый ключ нужен для
          старых резервных копий.
        </p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            recoveryDownload(recovery!.code, user.vaultName, user.epoch + 1);
            setDownloaded(true);
          }}
        >
          <Download size={16} />
          Скачать новый rescue-ключ
        </Button>
        <label className="check-label">
          <Checkbox
            checked={saved}
            disabled={!downloaded || busy}
            onCheckedChange={(checked) => setSaved(checked === true)}
          />
          Новый ключ сохранён отдельно от сервера
        </label>
        <div className="dialog-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setRevokeOpen(false)}
          >
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={!downloaded || !saved || busy}
            onClick={disable}
          >
            Отключить и сменить ключ
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
