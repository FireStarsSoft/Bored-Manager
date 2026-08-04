# Kế hoạch xây dựng Bored Manager (ServicesManager - cũ)

## 1. Thông tin tài liệu

- **Tên dự án:** Bored Manager
- **Loại dự án:** Greenfield; thư mục dự án chưa có source code hoặc kiến trúc cũ cần tương thích.
- **Nền tảng quản lý:** Ubuntu Desktop 24.04 LTS hoặc Kali Linux Rolling amd64, chạy 24/7 bằng systemd.
- **Đối tượng được quản lý:** Ubuntu 24.04 LTS hoặc Kali Linux Rolling amd64 chạy trong Docker
  container trên một hoặc nhiều Docker host thuộc cùng ma trận nền tảng được hỗ trợ.
- **Hình thức giao diện:** Web UI truy cập trong LAN bằng IP và port cấu hình được.
- **Người dùng:** Một tài khoản quản trị ở v1.
- **Mục đích của tài liệu:** Khóa mục tiêu, kiến trúc, interface, trình tự triển khai, tiêu chí kiểm thử và điều kiện nghiệm thu trước khi viết source code.

---

## 2. Tầm nhìn và mục tiêu

ServicesManager gồm một control plane trung tâm gọi là **A**, các **agent** chạy trong container
Ubuntu hoặc Kali được hỗ trợ, và các **Docker host connector** dùng SSH để A quản lý Docker Engine
từ xa.

Hệ thống phải giúp một người quản trị:

1. Quan sát tập trung tối đa 1.000 container Ubuntu/Kali được hỗ trợ. (có thể mở rộng lên nhiều container hơn)
2. Theo dõi tối đa 20 service trên mỗi agent. (có thể mở rộng lên nhiều service hơn)
3. Nhìn thấy ngay agent hoặc service nào offline, stale, stopped, failed hoặc unhealthy.
4. Cài đặt, gỡ, start, stop, restart, update và kiểm tra service bằng các service definition có version.
5. Mở terminal trực tiếp tới một container mà không cần mở terminal ngoài.
6. Gửi cùng một command line tới tối đa 200 container và nhận kết quả riêng từng target.
7. Đăng ký nhiều Docker host và tạo hàng loạt container từ template bất biến.
8. Hỗ trợ bridge, IP tĩnh, pool IP, macvlan/ipvlan và DHCP thông qua Docker plugin bên ngoài.
9. Cài đặt, cập nhật, rollback, stop/start/restart và clean uninstall A/agent một cách xác định.
10. Giữ A và agent nhỏ, modular, không cần PostgreSQL, Redis hoặc message broker ngoài.

### 2.1. Tính năng trọng tâm

Theo dõi service là tính năng quan trọng nhất. Dashboard phải thể hiện service theo mô hình nhiều dòng:

- Dòng đầu của mỗi agent hiển thị identity, trạng thái kết nối và tài nguyên.
- Dòng thứ hai trở đi hiển thị từng service đang được theo dõi.
- Người dùng phải phân biệt rõ “service không hỗ trợ”, “chưa cài”, “đã cài nhưng dừng”, “failed” và “health check lỗi”.

### 2.2. Tiêu chí thành công cấp hệ thống

- 1.000 agent × 20 service duy trì kết nối ổn định trong bài test 72 giờ.
- Agent offline được phát hiện trong tối đa 45 giây.
- Thay đổi trạng thái service xuất hiện tại A trong tối đa 60 giây với cấu hình mặc định.
- Batch command 200 target có độ lệch thời điểm bắt đầu p95 không quá 2 giây khi toàn bộ target đã sẵn sàng.
- Dashboard vẫn cuộn, tìm kiếm, lọc và nhận live update ở quy mô mục tiêu.
- Restart A không làm mất agent identity, alias, service assignment, template hoặc durable job.
- Retry provisioning/update không tạo container, IP reservation, identity hoặc job trùng.
- Stop/restart/update không để lại PTY, child process, socket hoặc listener mồ côi.
- Agent có RSS p95 không quá 35 MB và idle CPU dưới 0,5% trên workload tham chiếu.
- Manager daemon dùng dưới 512 MB RAM tại 1.000 kết nối, không tính browser.
- Clean purge không còn file, unit, process hoặc port do thành phần được chọn sở hữu.

### 2.3. Ngoài phạm vi v1

- Multi-user, RBAC và SSO.
- High availability cho manager hoặc database cluster.
- Public Internet exposure không thông qua LAN/VPN tin cậy.
- Quản lý Kubernetes, Docker Swarm hoặc LXD.
- Agent nằm ngoài managed container, dù chạy trên máy vật lý hay máy ảo.
- Tự cài đặt/nâng cấp Docker Engine trên Docker host.
- Batch terminal mirror raw keystroke hoặc chạy full-screen TUI đồng bộ.
- Email, Telegram, Slack, webhook hoặc cảnh báo bên ngoài.
- Tự động xóa container, image, volume, network hoặc service khi uninstall.
- Cấu hình clock/timezone riêng cho từng container.

---

## 3. Quyết định kiến trúc đã khóa

### 3.1. Technology stack

- **Controller, agent, CLI và update helper:** Go 1.26.x; pin bản patch cụ thể trong `go.mod`/toolchain khi bắt đầu triển khai.
- **Frontend:** React 19.2, TypeScript 6, Vite, TanStack Query, TanStack Table/Virtual và xterm.js.
- **Frontend build runtime:** Node.js 24 LTS.
- **Database:** SQLite với WAL; dùng pure-Go driver để dễ phát hành binary.
- **Agent protocol:** Protobuf + gRPC bidirectional streaming qua mTLS.
- **Web API:** REST JSON dưới `/api/v1`; OpenAPI là contract được generate và kiểm tra trong CI.
- **Live UI và terminal:** WebSocket.
- **Packaging:** `.deb`, systemd unit và amd64 binary.
- **Logs:** structured logs gửi tới journald; không tự quản lý file log không giới hạn.

Mọi dependency phải được khóa bằng `go.mod`, `go.sum` và frontend lockfile. Không sử dụng mutable dependency version trong CI/release.

### 3.2. Các thành phần chạy

#### `managerd`

- Systemd service chạy 24/7 trên Ubuntu Desktop 24.04 LTS hoặc Kali Linux Rolling amd64.
- Phục vụ SPA, REST API, WebSocket và agent gRPC endpoint.
- Quản lý database, PKI, agent connections, service catalog, jobs, alerts, Docker hosts, templates, provisioning và updates.
- Chạy bằng user hệ thống riêng, không chạy root.

#### `agentd`

- Một Go binary chạy bằng systemd trong mỗi managed container.
- Luôn tạo kết nối outbound tới A; không mở control port.
- Thu thập metrics, kiểm tra service, chạy typed action, terminal PTY và self-update.
- Chạy root vì cần quản lý systemd/service, nhưng terminal mặc định spawn bằng user không-root.

#### `smctl`

- CLI cục bộ cho diagnostics, backup/restore, reset admin password, token management, install/update/remove/purge và recovery.

#### `sm-update-helper`

- Root-owned helper có API rất hẹp.
- Chỉ nhận artifact đã ký, verify lại artifact, stage, atomic switch, restart và rollback manager.
- Không cung cấp generic root command execution.

#### Web SPA

- Bundle được embed vào `managerd` để không cần web server riêng.
- Giao diện dark, responsive trong desktop browser, tập trung vào bảng nhiều dòng và terminal.

#### Docker host connector

- A kết nối Docker host bằng SSH, kiểm tra host key nghiêm ngặt.
- Docker Engine API được tunnel tới Unix socket từ xa; không expose `tcp://2375`.
- Quyền truy cập Docker socket được xem là root-equivalent và phải được cảnh báo rõ.

#### External DHCP plugin adapter

- V1 không tự phát triển DHCP network/IPAM plugin.
- Người vận hành cung cấp Docker plugin tương thích.
- A lưu exact plugin name, digest và options; preflight phải xác minh plugin trước khi provision.

### 3.3. Network ports

- Web UI mặc định: `https://<configured-ip>:8443`.
- Agent gRPC mặc định: `<configured-ip>:9443`.
- Lần chạy đầu chỉ mở setup UI trên `127.0.0.1`.
- Sau khi tạo admin, certificate và chọn bind address, manager mới mở cổng LAN.
- Port phải cấu hình được; thay đổi port cần kiểm tra collision và restart có kiểm soát.

### 3.4. Security baseline

- Web UI dùng HTTPS tự ký; browser có thể hiển thị cảnh báo nhưng traffic vẫn được mã hóa.
- Một tài khoản admin duy nhất ở v1.
- Password hash bằng Argon2id với tham số được version hóa.
- Session cookie dùng `Secure`, `HttpOnly`, `SameSite=Strict`.
- Có CSRF protection, login rate limiting, idle timeout và absolute session lifetime.
- Agent transport luôn dùng mTLS riêng, không phụ thuộc certificate của Web UI.
- A tạo private CA cục bộ và hỗ trợ backup CA có mã hóa.
- Enrollment token dùng một lần, TTL mặc định 10 phút và có scope.
- Agent tự sinh private key; A không gửi private key xuống agent.
- Agent certificate sống 90 ngày và được xoay từ ngày thứ 60.
- Certificate bị revoke phải mất quyền kết nối ngay sau lần reconnect tiếp theo.
- SSH known-host mismatch luôn block, không có “accept automatically” sau lần trust đầu.
- SSH private key import vào A được mã hóa bằng master key root-owned, không lưu plaintext trong SQLite.
- Secret không được ghi vào log, audit payload, terminal transcript hoặc command-line process list.

---

## 4. Identity và enrollment

### 4.1. Hai lớp identity

- `logical_instance_id`: định danh ổn định cho một container logic do A quản lý.
- `agent_id`: UUIDv7 mới cho mỗi lần agent enrollment.
- Alias được gắn vào logical instance, không gắn trực tiếp vào certificate.
- Alias phải unique toàn hệ thống; UI tự đề xuất suffix khi trùng.

### 4.2. Recreate behavior

Khi container được recreate từ cùng logical instance:

- Giữ alias, tags, service assignments, lịch sử và network reservation.
- Tạo agent UUID, private key và certificate mới.
- Record mới có `supersedes_agent_id` trỏ tới enrollment trước.
- Agent cũ được chuyển thành superseded/revoked.
- Giữ IP/MAC nếu network profile không đổi.

### 4.3. Enrollment flow

1. A tạo one-time token gắn với logical instance/template và TTL 10 phút.
2. Agent tự tạo keypair trong `/var/lib/services-manager-agent`.
3. Agent kết nối TLS tới A bằng CA fingerprint được pin.
4. Agent gửi token, public key và minimal inventory.
5. A dùng transaction để consume token và cấp UUIDv7.
6. A ký client certificate và trả certificate chain/config.
7. Agent persist identity bằng permission root-only.
8. Agent reconnect bằng mTLS và gửi full inventory.
9. A đánh dấu logical instance online sau heartbeat hợp lệ đầu tiên.

Không bake agent UUID, token, certificate, SSH host key hoặc secret vào derived image.

---

## 5. Public API và contract

### 5.1. REST API

Những resource chính dưới `/api/v1`:

- `/auth`, `/sessions`, `/setup`
- `/agents`, `/logical-instances`, `/groups`
- `/alerts`, `/audit-events`
- `/service-definitions`, `/service-revisions`
- `/service-assignments`, `/remediation-rules`
- `/docker-hosts`, `/ssh-credentials`
- `/network-profiles`, `/ip-reservations`
- `/templates`, `/template-revisions`, `/derived-images`
- `/provision-jobs`, `/command-jobs`, `/service-jobs`
- `/releases`, `/update-rollouts`
- `/backups`, `/diagnostics`

Quy tắc API:

- Resource mutation dùng optimistic version hoặc ETag để tránh ghi đè.
- List API hỗ trợ pagination, filter và stable sorting.
- Bulk action phải nhận immutable target IDs, không nhận query động sẽ thay đổi trong khi chạy.
- Error response có stable machine code, message cho user và correlation ID.
- Mọi destructive endpoint yêu cầu explicit confirmation token.
- OpenAPI schema được xem là public contract và có compatibility test.

### 5.2. Agent stream messages

- `Hello`, `Heartbeat`, `InventorySnapshot`
- `MetricsSample`, `ServiceStateDelta`
- `JobOffer`, `JobAck`, `JobProgress`, `JobResult`
- `ShellOpen`, `ShellData`, `ShellResize`, `ShellSignal`, `ShellClose`
- `UpdatePrepare`, `UpdateCommit`, `UpdateResult`
- `CertificateRotateRequest`, `CertificateRotateResult`

Mọi message có `protocol_version`, `agent_id`, sequence number và timestamp. Server phải reject frame vượt size limit hoặc sai state transition.

### 5.3. Durable job contract

Mọi job có:

- `job_id`
- `job_type`
- `target_id`
- `idempotency_key`
- `created_at`, `deadline`, `attempt`
- Immutable input snapshot
- Per-target state
- Bounded stdout/stderr
- Exit code, error code và duration
- Actor/audit metadata

State machine chuẩn:

`queued -> offered -> acknowledged -> running -> succeeded|failed|cancelled|expired`

Retry chỉ tạo attempt mới trong cùng job target; không tạo resource mới nếu attempt trước đã commit.

---

## 6. Service catalog và monitoring

### 6.1. Service definition revision

Mỗi revision bất biến gồm:

- Stable service key và display name.
- Catalog/revision version.
- OS release (`ubuntu-24.04` hoặc `kali-rolling`) và architecture hỗ trợ.
- Detection adapter.
- Runtime check và optional health probes.
- Install, uninstall, start, stop, restart, update và remediation action.
- Build-time install instructions và runtime configuration riêng.
- Script checksum/signature.
- Required privilege/capability.
- Timeout, output cap và optional rollback hint.

### 6.2. Check adapters v1

- `systemd`: unit exists, enablement, active/substate và failure details.
- `process`: executable/command line hoặc PID ownership.
- `tcp`: connect host/port trong timeout.
- `http`: method, URL, expected status và optional body matcher.
- `command`: signed command/script trả structured result.

### 6.3. State model

Không gộp trạng thái thành một boolean:

- **Availability:** `unsupported`, `absent`, `installed`, `unknown`
- **Runtime:** `active`, `inactive`, `starting`, `failed`, `unknown`
- **Health:** `healthy`, `degraded`, `unhealthy`, `not_configured`
- **Presence:** `online`, `stale`, `offline`

Mỗi observed state chứa version, last check, last transition, duration và bounded error summary.

### 6.4. Assignment

- Scope hỗ trợ: global, group, template và agent.
- Effective tracked set là union của các scope.
- Explicit per-agent exclusion có ưu tiên cao nhất.
- Agent nhận desired assignment snapshot có revision.
- Agent tiếp tục local monitoring khi mất kết nối với A.

### 6.5. Scheduling

- Heartbeat mặc định 15 giây có jitter.
- Service check mặc định 30 giây có jitter.
- Check timeout mặc định 5 giây.
- State được coi stale sau ba chu kỳ không có dữ liệu.
- Agent chỉ gửi delta khi state thay đổi; full snapshot mỗi 5 phút.
- Một check treo/lỗi không được block các check khác.

### 6.6. Script execution policy

- Chỉ chạy revision đã pin và hash đã verify.
- Noninteractive; không chờ prompt.
- Working directory tạm riêng cho từng job.
- Minimal environment allowlist.
- Process group riêng, timeout và kill escalation xác định.
- Stdout/stderr giới hạn kích thước.
- Secret values được redact.
- Install/update/uninstall script phải idempotent hoặc có precondition rõ.

### 6.7. Auto-remediation

- Mặc định tắt.
- Chỉ gọi action đã được định nghĩa trong service revision.
- Trigger mặc định sau ba check failed/unhealthy liên tiếp.
- Tối đa ba lần trong 30 phút.
- Backoff mặc định 1, 5 và 15 phút.
- Sau khi hết lượt thử, khóa rule 60 phút và tạo alert.
- Mọi lần remediation tạo durable job và audit event.

---

## 7. Dashboard và trải nghiệm người dùng

### 7.1. Agent row-group

Mỗi agent là một row-group có thể expand/collapse.

**Dòng 1:**

- Checkbox chọn target.
- Presence/severity indicator.
- Alias và short UUID.
- Docker host/container name.
- CPU, RAM, disk và network rate.
- Agent version và last seen.
- Alert/action menu.

**Dòng 2 trở đi:**

- Một dòng cho mỗi monitored service.
- Availability, runtime, health và version.
- Last check, last transition và error summary.
- Actions: install/update/start/stop/restart/details.

### 7.2. Điều hướng

- Overview Dashboard
- Agents
- Services/Catalog
- Docker Hosts
- Network Profiles
- Templates
- Provisioning Jobs
- Terminal/Batch Commands
- Alerts
- Releases/Updates
- Audit/Backups
- Settings/Security

### 7.3. Dashboard behavior

- Service lines mở mặc định vì đây là tính năng trọng tâm.
- Search/filter theo alias, UUID, tag, host, presence, service và service state.
- Sort theo severity, last seen và resource usage.
- Selection dùng immutable target snapshot.
- Details drawer hiển thị inventory, network, service history, jobs và connection history.
- Dùng text/icon cùng màu để bảo đảm accessibility.
- Dữ liệu stale không tiếp tục hiển thị màu xanh.
- Virtualize toàn row-group; không render đồng thời toàn bộ 20.000 service rows.

### 7.4. In-app alerts

- Agent offline/stale.
- Service failed/unhealthy.
- Remediation exhausted.
- Update/provision job partial failure.
- Certificate sắp hết hạn hoặc rotation lỗi.
- Plugin/network preflight lỗi.

Alert có severity, deduplication key, first/last seen, count, unread và acknowledge state. V1 không gửi alert ra hệ thống ngoài.

---

## 8. Terminal và batch command

### 8.1. Terminal đơn qua agent

- xterm.js kết nối WebSocket tới manager.
- Manager route PTY frames qua agent stream.
- Hỗ trợ resize, Unicode, ANSI, signal, Ctrl-C và idle timeout.
- Mặc định spawn user `smadmin` không-root.
- Root terminal yêu cầu re-authenticate, xác nhận target và hiển thị root badge.
- Chỉ audit start/end, target, actor và privilege; không lưu transcript.
- Close session/browser phải kill process group sau grace period.

### 8.2. SSH fallback

- Chỉ dùng khi target có sshd và SSH profile.
- Key-based authentication; không khuyến khích password.
- Strict known_hosts.
- Direct LAN route hoặc ProxyJump qua Docker host.
- Root elevation dùng `sudo -n`; không broadcast password.

### 8.3. Batch command

- Tối đa 200 target.
- Target list được chụp cố định khi mở session.
- Mỗi target có shell riêng và giữ cwd/environment trong session.
- Chỉ gửi command line hoàn chỉnh, không mirror từng phím.
- Trước execution, A gửi prepare, thu ready states rồi commit theo barrier.
- Output luôn gắn alias và UUID.
- Có aggregate view, per-target tab, exit code và duration.
- Lỗi một target không dừng target khác.
- Agent channel cho phép tối đa 200; SSH fallback giới hạn concurrency 25.
- Có cancel all, cancel target và retry failed only.
- Root batch yêu cầu re-authentication và xác nhận bổ sung.

---

## 9. Docker hosts và provisioning

### 9.1. Host registration

Mỗi Docker host profile gồm:

- Name, IP/DNS và SSH port.
- Username và SSH credential reference.
- Expected SSH host fingerprint.
- Docker socket path.
- Host capabilities/inventory.
- Network parent interfaces.
- Allowed image sources và builder role.

A chỉ dùng Docker Engine có sẵn; không cài hoặc nâng cấp Docker.

### 9.2. Host preflight

- Ubuntu 24.04 LTS hoặc Kali Linux Rolling, amd64.
- Docker Engine/API compatibility.
- cgroup v2 và systemd-container profile.
- BuildKit availability.
- CPU/RAM/disk/PID capacity.
- Network interfaces/subnets/VLAN.
- Plugin name/state/digest.
- Image availability và registry access.
- Name, IP, MAC và published-port collisions.

Reference certification v1 dùng Docker Engine 29.6.x; compatibility floor là Docker Engine 28.5.1 với API negotiation.

### 9.3. Template revision

Template bất biến gồm:

- Base image reference hoặc local image/archive.
- Resolved SHA-256 digest.
- Service definition revisions.
- Agent version/channel.
- CPU/RAM/PID/shm limits.
- Volumes, environment và secret-file references.
- Restart policy.
- Systemd runtime profile và capabilities/devices.
- Management/workload network profiles.
- DNS, ports và SSH policy.
- Naming/alias pattern.
- Risk classification.

Editing template đã publish phải tạo revision mới.

### 9.4. Derived image pipeline

1. Resolve base image thành immutable digest.
2. Generate Dockerfile/build context từ template revision.
3. Build một lần bằng BuildKit trên builder host.
4. Cài agent, `smadmin`, systemd và selected services.
5. Không start service trong build; chỉ enable/configure cho runtime.
6. Ghi output digest và build provenance.
7. Export image archive vào A cache.
8. Stream/load cùng artifact sang selected hosts.
9. Mọi container của một job dùng đúng cùng digest.

First boot chỉ làm:

- Sinh SSH host key nếu SSH được bật.
- Nhận runtime config.
- Nhận enrollment token qua tmpfs/stdin.
- Enroll agent.
- Start services đã enable.

### 9.5. Network architecture

Mỗi managed container luôn có management bridge cho agent outbound.

Workload network modes:

1. User-defined bridge với Docker IPAM dynamic.
2. Bridge với static IP.
3. macvlan/ipvlan L2 với global pool do A quản lý.
4. External Docker network/IPAM plugin cho DHCP thật.

Network profile lưu:

- Driver và mode.
- Parent interface/VLAN.
- Subnet, gateway và IP range.
- Exclusions/aux addresses.
- Static/dynamic/DHCP allocation.
- DNS servers/search domains.
- Plugin name, exact digest và options.
- Maximum endpoint count.

Quy tắc:

- A-managed IP pool reserve bằng SQLite transaction trước container create.
- Stable MAC được sinh từ logical instance và kiểm tra collision.
- DHCP plugin phải installed/enabled, đúng digest và vượt connectivity/lease test.
- Missing plugin/digest mismatch làm fail preflight.
- A không tự sửa host NIC/bridge nếu chưa có xác nhận riêng.
- Management bridge bảo đảm agent vẫn kết nối khi macvlan/ipvlan có host-connectivity limitation.
- Hard cap 800 endpoint trên một bridge/network; khuyến nghị tối đa 500.
- Thay đổi subnet/gateway/driver tạo network revision mới và cần rolling recreate.
- Không sửa netplan bên trong container.
- Không có Time Settings UI/API. Container dùng kernel clock và `/etc/localtime` read-only từ host.

### 9.6. Provision job flow

1. Chọn template revision, hosts, count và naming pattern.
2. Dry-run capacity/network/image preflight.
3. Tạo immutable job snapshot.
4. Reserve names, logical IDs, MAC/IP và tokens.
5. Distribute exact derived image.
6. Tạo container với labels:
   - `managed-by=services-manager`
   - `logical-instance-id`
   - `template-revision`
   - `provision-job-id`
7. Gắn management/workload networks.
8. Start container.
9. Inject token qua stdin vào tmpfs; không dùng image/env/argv.
10. Chờ agent enrollment.
11. Chờ required services đạt desired state.
12. Báo kết quả riêng từng target.

Retry chỉ chạy target lỗi. Rollback chỉ xóa tài nguyên có job label tương ứng và không đụng resource tồn tại trước job.

---

## 10. Update, rollback và lifecycle

### 10.1. Release manifest

Release source có thể là generic URL hoặc local file. GitHub Releases chỉ là một URL source tùy chọn.

Canonical manifest gồm:

- Schema/version/channel.
- Protocol/database compatibility.
- Component, OS và architecture.
- Artifact URL/path, size và SHA-256.
- Published time.
- Ed25519 signature.

Installer/updater pin release public key. Agent không tải trực tiếp từ Internet; A tải một lần, verify và cache.

### 10.2. Manager update

1. Admin chọn signed release.
2. Download vào staging.
3. Verify signature, hash và compatibility.
4. Backup SQLite, CA metadata và config.
5. Root helper atomic switch version.
6. Restart manager.
7. Health check trong 60 giây.
8. Nếu migration/startup fail, rollback binary và database backup.

Manager N phải tương thích agent N và N-1.

### 10.3. Agent rollout

- Manual approval.
- Canary 1% trong 10 phút.
- Wave 10%, 25% và 100%.
- Concurrency giới hạn theo host.
- Tự dừng nếu failure vượt 2%, agent không reconnect trong 45 giây hoặc crash/check error tăng bất thường.
- Agent giữ previous version và rollback atomic.
- Rollout có thể resume sau manager restart.

### 10.4. Install paths

- Versioned binaries dưới `/usr/lib`.
- CLI symlink dưới `/usr/bin`.
- Config dưới `/etc`.
- Database/identity/state dưới `/var/lib`.
- Cache/staging dưới `/var/cache`.
- Logs qua journald.
- Mọi path thuộc sở hữu project được ghi trong ownership manifest.

### 10.5. Remove và purge

- `remove`: stop/disable unit và xóa binary/unit; giữ state/resources.
- `purge`: bắt buộc wizard hoặc CLI flags rõ cho từng nhóm.

Nhóm lựa chọn:

- Config/database/cert/cache.
- Containers.
- Derived images.
- Managed networks.
- Volumes.
- Services do catalog cài.
- DHCP plugin.

Mỗi nhóm bắt buộc chọn Keep/Delete; destructive choices mặc định chưa chọn. Trước khi delete:

1. Export inventory/ownership manifest.
2. Hiển thị exact resource count.
3. Yêu cầu typed confirmation.
4. Chỉ xóa Docker resources có managed labels và khớp database ownership.
5. Chạy residue verification sau cùng.

Agent uninstall không tự gỡ monitored services. Manager uninstall không tự xóa container.

---

## 11. Data model và retention

### 11.1. Nhóm entity

- Admin user/session/security settings.
- Logical instance/agent enrollment/alias/tag/inventory.
- Docker host/SSH credential reference.
- Service definition/revision/assignment/observed state/remediation rule.
- Network profile/revision/IP reservation.
- Template/revision/derived image.
- Job/job target/progress/result.
- Release/rollout/rollback state.
- Alert/audit event/backup metadata.

### 11.2. Retention mặc định

- Current agent/service state: giữ đến khi record bị xóa.
- Metrics aggregate 1 phút: 24 giờ.
- Metrics aggregate 15 phút: 30 ngày.
- Service transitions và alerts: 90 ngày.
- Job command/output: 30 ngày, tối đa 1 MiB mỗi target.
- Audit metadata: 180 ngày.
- Interactive terminal transcript: không lưu.
- Database/cache cap: 10 GiB mặc định.
- Online backup hàng ngày, giữ bảy bản.
- Manager update luôn backup trước migration.

---

## 12. Lộ trình triển khai

### Giai đoạn 0 — Foundation và feasibility gates

**Mục đích:** Loại bỏ rủi ro systemd, networking, SSH, PTY và scale trước khi xây feature lớn.

**Việc thực hiện:**

1. Khởi tạo Git, license, README, ADR và CI.
2. Tạo module boundaries cho manager, agent, CLI, updater, API, web, catalog, packaging và lab.
3. Khóa toolchain/dependencies.
4. PoC Docker Engine API qua SSH với strict host-key checking.
5. PoC systemd PID 1 riêng cho official Ubuntu 24.04 image và digest-pinned Kali Linux Rolling
   image:
   - `STOPSIGNAL SIGRTMIN+3`
   - tmpfs `/run` và `/run/lock`
   - private cgroup namespace/cgroup v2
   - default AppArmor/seccomp
   - không dùng privileged mặc định
6. PoC agent enrollment/mTLS/reconnect.
7. PoC PTY/resize/cancel/process cleanup.
8. PoC 1.000 simulated streams và 20 service states/agent.
9. PoC bridge, macvlan, ipvlan, A-managed pool và external DHCP plugin.
10. Ghi ADR cho kết quả.

**Gate:**

- Manager/host restart không mất enrollment.
- Clone không trùng UUID/certificate/SSH host key.
- DHCP lease acquire/renew/release được trong lab.
- Plugin mismatch bị block.
- PTY close không còn process.
- 1.000 reconnect không tạo storm.
- Nếu systemd least-privilege profile thất bại, dừng và sửa thiết kế; không tự bật privileged.

### Giai đoạn 1 — Controller, database và agent core

**Mục đích:** Có control plane bền vững và agent đăng ký được.

**Việc thực hiện:**

1. `managerd` config, logging, graceful shutdown và health endpoints.
2. SQLite migrations, WAL, backup/restore và recovery.
3. First-run admin, HTTPS tự ký và LAN bind settings.
4. Private CA, token, enrollment, rotation và revocation.
5. gRPC bidirectional stream, heartbeat, reconnect backoff và bounded offline queue.
6. Metrics từ cgroup/proc/statfs.
7. Logical instance/agent lifecycle và alias rename.
8. `.deb`/systemd packaging cho agent.

**Gate:**

- One-line agent install đăng ký trong tối đa 60 giây.
- Token reuse/expiry bị từ chối.
- Revoked cert không reconnect được.
- Rename alias không đổi UUID.
- Restart hai phía tự phục hồi.
- Stop agent dọn hết child processes.

### Giai đoạn 2 — Service catalog và monitoring core

**Mục đích:** Hoàn thành domain quan trọng nhất.

**Việc thực hiện:**

1. Service manifest schema.
2. Local editor/import và URL/Git sync.
3. Immutable revisions và signed/hash verification.
4. Systemd/process/TCP/HTTP/command adapters.
5. Durable install/uninstall/start/stop/restart/update jobs.
6. Secure bounded script runner.
7. Scope assignments.
8. Remediation rules.
9. Delta/full snapshot pipeline và state history.

**Gate:**

- Phân biệt đúng mọi state axis.
- Check treo không block check khác.
- Scripts idempotent.
- Offline monitoring tiếp tục.
- Reconnect không chạy lại job đã hoàn tất.
- State transition tới A trong tối đa hai check cycles.

### Giai đoạn 3 — Dashboard và alerts

**Mục đích:** Vận hành 1.000 agent rõ ràng và mượt.

**Việc thực hiện:**

1. SPA shell, auth, routing và settings.
2. Virtualized agent row-groups.
3. Live WebSocket updates.
4. Search/filter/sort/bulk selection.
5. Agent details drawer.
6. In-app alerts, acknowledge và deduplication.
7. Accessibility và stale-state handling.

**Gate:**

- Load 1.000 × 20 dưới 3 giây trên máy 4 vCPU/8 GB.
- Filter/sort p95 dưới 200 ms.
- Không nhầm state khi reorder.
- Live update không phá selection.
- Không false-green cho stale/offline agent.

### Giai đoạn 4 — Terminal và batch command

**Mục đích:** Sửa lỗi trực tiếp từ A.

**Việc thực hiện:**

1. PTY qua agent stream và xterm.js.
2. SSH fallback/ProxyJump.
3. Non-root/default và explicit root elevation.
4. Batch target snapshot, prepare/commit barrier.
5. Per-target output/state/exit code.
6. Cancellation, backpressure và cleanup.

**Gate:**

- 200 agent có start skew p95 dưới 2 giây.
- Output không bao giờ gán sai target.
- Cancel/Ctrl-C dừng đúng process.
- Disconnect/large output không treo UI.
- Không lưu interactive transcript.

### Giai đoạn 5 — Docker hosts, templates và provisioning

**Mục đích:** Tạo container hàng loạt có thể lặp lại.

**Việc thực hiện:**

1. Host registration/preflight.
2. Network profiles/IP reservations/plugin validation.
3. Template revisioning.
4. Derived image builder/cache/distribution.
5. Durable provision job và rollback theo labels.
6. First-boot identity injection/enrollment.
7. Progress UI và retry failed targets.

**Gate:**

- Batch 100 có identity/SSH key riêng.
- Cùng image digest/template revision.
- Retry không duplicate.
- Static pool không cấp trùng IP.
- DHCP lease được release khi xóa.
- Enrollment/bootstrap lỗi không báo success.
- Recreate giữ alias/history, đổi agent identity.

### Giai đoạn 6 — Update, packaging và clean lifecycle

**Mục đích:** Install/update/rollback/uninstall dễ và sạch.

**Việc thực hiện:**

1. Signed release manifest và artifact cache.
2. Manager update helper/backup/rollback.
3. Agent canary rollout.
4. `.deb`, one-line installer và systemd units.
5. Ownership manifest.
6. Remove/purge wizard và residue verification.

**Gate:**

- Invalid artifact/signature luôn bị reject.
- Manager/agent update lỗi tự rollback.
- Rollout resume được sau restart.
- Repeated lifecycle operations idempotent.
- Purge chỉ xóa scope được chọn và không còn residue.

### Giai đoạn 7 — Hardening và v1 release

**Mục đích:** Chứng minh reliability/security/scale trước stable release.

**Việc thực hiện:**

1. Threat-model review và dependency audit.
2. Fault injection/chaos tests.
3. Long-running resource tests.
4. Backup/restore/disaster-recovery drills.
5. Documentation, runbooks và troubleshooting bundle.
6. Lab/pilot/scale rollout.

**Gate:**

- Lab 10 real containers trong 24 giờ.
- Pilot 100 real containers trên ít nhất hai host trong 48 giờ.
- Scale 1.000 live agents × 20 services và batch 200 trong 72 giờ.
- Không memory leak, reconnect storm hoặc unbounded database growth.
- Toàn bộ security/update/purge acceptance tests pass.

---

## 13. Kế hoạch kiểm thử

### 13.1. Unit tests

- Identity state machines.
- Token/certificate expiry và revocation.
- Assignment precedence.
- Service state mapping.
- IP allocation/reservation.
- Job idempotency/transitions.
- Release/catalog signature verification.
- Retention/housekeeping.
- Remediation backoff/cooldown.

### 13.2. Fuzz/property tests

- Protobuf/message decoding.
- YAML/JSON manifests.
- Terminal frame parsing.
- Release canonicalization/signature input.
- IP/subnet/range validation.
- Job recovery data.

### 13.3. Integration tests

- Real manager + agent + SQLite.
- Enrollment/reconnect/rotation/revocation.
- Real systemd-enabled Ubuntu 24.04 và Kali Linux Rolling container.
- Service install/control/check/remediation.
- Docker API over SSH.
- Image build/distribution.
- Provision retry/rollback.
- Manager/agent update and rollback.

### 13.4. Frontend/E2E tests

- First-run setup/login/logout/session expiry.
- 1.000 virtualized row-groups.
- Search/filter/sort/live update.
- Alias rename.
- Service actions và alerts.
- Terminal resize/cancel.
- Batch partial failure.
- Provision wizard/dry-run/progress.
- Update rollout/purge confirmations.
- Keyboard navigation/color-independent state display.

### 13.5. Network lab tests

- Bridge dynamic/static.
- Multiple bridge segmentation.
- macvlan/ipvlan L2.
- IP/MAC collision.
- External DHCP acquire/renew/release.
- DHCP timeout/plugin mismatch.
- Parent interface failure.
- DNS/gateway behavior.
- Agent management connectivity khi workload network lỗi.

### 13.6. Chaos/recovery tests

- Manager kill/restart giữa job.
- Agent kill/restart giữa action.
- Docker host reboot.
- LAN flap và packet loss.
- SQLite disk full/backup restore.
- Image build/pull/load failure.
- Partial container creation.
- Update binary mới không start.
- DB migration failure.

### 13.7. Security tests

- Expired/reused enrollment token.
- Revoked/forged certificate.
- SSH host-key mismatch.
- Invalid catalog/release signature.
- CSRF/session fixation/brute force.
- Secret redaction.
- Script hash mismatch/path traversal/output flood.
- Unauthorized root terminal/update helper request.
- Destructive API without confirmation token.

### 13.8. Lifecycle/residue tests

- Repeated install/start/stop/restart/update/remove/purge.
- Kiểm tra systemd units, process tree và listeners.
- Kiểm tra config/state/cache/staging/socket/lock files.
- Xác minh user-owned containers/services được giữ khi không chọn delete.
- Xác minh chỉ resource có đúng ownership labels bị xóa.

---

## 14. Nghiệm thu chức năng

- Agent manual install và template first boot đều enroll thành công.
- Alias và history tồn tại qua recreate nhưng agent UUID đổi.
- Dashboard thể hiện đúng mọi combination availability/runtime/health.
- In-app alert deduplicate và acknowledge đúng.
- Single terminal hoạt động qua agent và SSH fallback.
- Batch command có kết quả riêng từng target và partial failure handling.
- Provisioning hỗ trợ registry image và local image/archive.
- Template cài selected services một lần trong derived image.
- Network profile hỗ trợ bridge, pool static, macvlan/ipvlan và external DHCP plugin.
- Manager/agent update rollback được khi release mới không healthy.
- Purge chỉ xóa đúng phạm vi người dùng đã chọn.

---

## 15. Tài liệu và vận hành cần bàn giao

- Architecture overview và ADR index.
- Installation guide cho manager/agent.
- First-run security/setup guide.
- Docker host onboarding/preflight guide.
- Service definition authoring guide.
- Template/image/network guide.
- DHCP plugin compatibility contract.
- Terminal và batch safety guide.
- Update/rollback/recovery runbook.
- Backup/restore/disaster recovery guide.
- Remove/purge ownership guide.
- Troubleshooting/diagnostic bundle guide.
- Scale test report và v1 acceptance report.

---

## 16. Giả định và mặc định cuối cùng

- Manager, Docker hosts và managed containers dùng Ubuntu 24.04 LTS hoặc Kali Linux Rolling amd64 ở
  v1. Kali được chuẩn hóa thành `kali-rolling` từ `ID=kali` và
  `VERSION_CODENAME=kali-rolling`; certification vẫn ghi `VERSION_ID` thực tế.
- Kali chỉ dùng một suite chính thức nhất quán: `kali-rolling` hoặc `kali-last-snapshot`. Không trộn
  repository Ubuntu, Debian, nhiều Kali suite hoặc repository của bản phân phối khác.
- Docker Engine đã có sẵn; A không cài/nâng cấp Docker.
- Web UI dùng HTTPS tự ký, single admin và LAN/VPN tin cậy.
- Agent endpoint luôn dùng mTLS.
- Một manager instance và SQLite local; không HA.
- Agent chỉ hỗ trợ Docker container; physical Docker hosts chỉ được quản lý qua SSH connector.
- Service monitoring được triển khai và nghiệm thu trước provisioning/terminal hoàn chỉnh.
- Template v1 dùng derived image + systemd.
- Agent bắt buộc có trong mọi managed image.
- Docker-in-Docker không phải mặc định.
- Privileged/high-risk template phải có cảnh báo và xác nhận riêng.
- Terminal mặc định non-root; root elevation luôn tường minh.
- Batch v1 gửi command line, không mirror raw keystroke.
- DHCP dùng external pinned plugin; project không vendor plugin mặc định.
- Alerts v1 chỉ nằm trong ứng dụng.
- Auto-remediation mặc định tắt.
- Không có time configuration cho container; container dùng host clock/timezone.
- Uninstall luôn yêu cầu chọn phạm vi; không có destructive default.
- Không bắt đầu triển khai source code trước khi feasibility gates và public contracts trong tài liệu này được chấp nhận.

---

## 17. Nguồn tham khảo kỹ thuật

- Docker Engine over SSH và daemon security: <https://docs.docker.com/engine/security/protect-access/>
- Docker Engine API/version negotiation: <https://docs.docker.com/reference/api/engine/>
- Docker Engine trên Ubuntu: <https://docs.docker.com/engine/install/ubuntu/>
- BuildKit: <https://docs.docker.com/build/buildkit/>
- Image digests: <https://docs.docker.com/dhi/explore/security-concepts/digests/>
- Bridge networking: <https://docs.docker.com/engine/network/drivers/bridge/>
- macvlan: <https://docs.docker.com/engine/network/drivers/macvlan/>
- ipvlan: <https://docs.docker.com/engine/network/drivers/ipvlan/>
- Docker network plugins: <https://docs.docker.com/engine/extend/plugins_network/>
- Go release history: <https://go.dev/doc/devel/release>
- React versions: <https://react.dev/versions>
- Node.js release schedule: <https://nodejs.org/en/about/previous-releases>
- TypeScript release notes: <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html>
