<!--
База знаний локального ИИ: шпаргалки по инструментам DevOps. Строки идут в подсказку модели,
когда запрос похож на тему, поэтому формат простой и строгий:

  # <инструмент>
  алиасы: <слова, по которым узнаём тему, через запятую>
  - <команда> — <что делает>

Команды — с заглушками в угловых скобках (<ns>, <pod>), без реальных хостов, адресов и паролей.
Опасные вещи (удаление, перезапись) либо не пишем, либо только с ключом подтверждения.
-->

# kubectl
алиасы: k8s, kubernetes, кубер, куб, под, pod, поды, неймспейс, namespace, деплой, deployment, кластер, кубектл
- kubectl -n <ns> get pods -o wide — поды неймспейса с узлами и адресами
- kubectl -n <ns> get pods --sort-by=.status.containerStatuses[0].restartCount — поды по числу перезапусков
- kubectl -n <ns> describe pod <pod> — события и причины: образ, ресурсы, тома
- kubectl -n <ns> logs <pod> -c <container> --tail=200 -f — логи контейнера, следить
- kubectl -n <ns> logs <pod> --previous — логи упавшего контейнера до перезапуска
- kubectl -n <ns> exec -it <pod> -- sh -c 'ps -o pid,comm' — команда внутри пода
- kubectl -n <ns> rollout restart deploy/<name> — перезапуск деплоя
- kubectl -n <ns> rollout status deploy/<name> --timeout=120s — дождаться раскатки
- kubectl -n <ns> rollout undo deploy/<name> — откатить на прошлую версию
- kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -30 — последние события
- kubectl -n <ns> port-forward svc/<svc> 8080:80 — порт сервиса к себе
- kubectl top pod -n <ns> --containers — потребление CPU и памяти
- kubectl get nodes -o wide — узлы, версии kubelet, адреса
- kubectl -n <ns> get pvc,pv — тома и их статус
- kubectl -n <ns> get secret <name> -o jsonpath='{.data.<key>}' | base64 -d — значение секрета
- kubectl -n <ns> scale deploy/<name> --replicas=3 — число реплик
- kubectl -n <ns> get deploy <name> -o yaml | kubectl neat — манифест без служебных полей
- kubectl auth can-i --list -n <ns> — что разрешено текущему контексту
- kubectl config get-contexts — контексты kubeconfig
- kubectl -n <ns> get pods --field-selector status.phase!=Running — всё, что не работает
- kubectl -n <ns> debug <pod> -it --image=nicolaka/netshoot --target=<container> — временный контейнер с сетевыми утилитами рядом
- kubectl -n <ns> cp <pod>:<path> <local> — забрать файл из пода
- kubectl -n <ns> get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated.exitCode}' — код выхода прошлого запуска
- kubectl -n <ns> set image deploy/<name> <container>=<image> — поменять образ
- kubectl -n <ns> annotate deploy/<name> kubectl.kubernetes.io/restart-at="$(date -Is)" --overwrite — пометить раскатку
- kubectl api-resources --verbs=list --namespaced -o name — какие ресурсы вообще есть в кластере
- kubectl -n <ns> get all,ing,pvc -o wide — всё основное одним списком

# helm
алиасы: хелм, чарт, chart, релиз, release, values
- helm -n <ns> list -a — релизы неймспейса, включая неудачные
- helm -n <ns> history <release> — версии релиза
- helm -n <ns> get values <release> -a — значения, с которыми раскатан релиз
- helm -n <ns> upgrade --install <release> <chart> -f values.yaml --atomic --timeout 5m — раскатка с откатом при ошибке
- helm -n <ns> rollback <release> <revision> — откат на версию
- helm -n <ns> diff upgrade <release> <chart> -f values.yaml — что изменится (плагин helm-diff)
- helm template <release> <chart> -f values.yaml | kubectl apply --dry-run=server -f - — проверить манифесты
- helm -n <ns> uninstall <release> — удалить релиз (спросить подтверждение)

# docker
алиасы: докер, контейнер, container, образ, image, compose, компоуз
- docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' — контейнеры и их состояние
- docker logs -f --tail 200 <name> — логи контейнера
- docker exec -it <name> sh — оболочка внутри контейнера
- docker stats --no-stream — CPU, память, сеть по контейнерам
- docker inspect -f '{{json .State.Health}}' <name> — состояние health-check
- docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' — образы с размером
- docker system df — чем занято место
- docker compose up -d --build — поднять стек из compose-файла
- docker compose logs -f --tail 200 <service> — логи сервиса стека
- docker compose ps — состояние сервисов стека
- docker run --rm -it --network container:<name> nicolaka/netshoot — сеть чужого контейнера глазами утилит
- docker cp <name>:<path> <local> — забрать файл из контейнера
- docker builder prune -f --filter until=72h — почистить кэш сборки старше трёх суток
- docker image prune -a -f --filter until=168h — удалить неиспользуемые образы старше недели
- docker events --since 1h --filter type=container — что происходило с контейнерами за час

# systemd
алиасы: systemctl, journalctl, сервис, служба, service, демон, юнит, unit, автозапуск
- systemctl status <unit> --no-pager -l — состояние службы и последние строки лога
- systemctl restart <unit> — перезапуск
- systemctl enable --now <unit> — включить и запустить
- systemctl list-units --failed — что упало
- systemctl list-timers --all — таймеры и когда сработают
- systemctl cat <unit> — юнит целиком, с переопределениями
- systemctl show <unit> -p FragmentPath,Restart,ExecStart — отдельные параметры
- journalctl -u <unit> -n 200 --no-pager — последние строки лога службы
- journalctl -u <unit> -f — следить за логом
- journalctl -u <unit> --since '1 hour ago' -p err — только ошибки за час
- journalctl -b -1 -p err --no-pager — ошибки предыдущей загрузки
- systemctl edit <unit> — переопределение юнита (drop-in), не трогая пакетный файл
- systemctl daemon-reload — перечитать юниты после правок
- systemd-analyze blame | head -20 — что дольше всего стартует
- journalctl --disk-usage и journalctl --vacuum-size=500M — сколько занимает журнал и как ужать
- journalctl -f -u <unit> -o cat — лог без служебных префиксов

# terraform
алиасы: терраформ, tofu, опентофу, план, plan, state, стейт, инфраструктура как код
- terraform init -upgrade — модули и провайдеры
- terraform plan -out tf.plan — план в файл, чтобы применить ровно его
- terraform apply tf.plan — применить сохранённый план
- terraform plan -target=module.<name> — план только по части конфигурации
- terraform fmt -recursive — форматирование
- terraform validate — проверка синтаксиса и типов
- terraform state list — объекты в состоянии
- terraform state show <addr> — один объект из состояния
- terraform output -json — выходные значения машинно
- terraform workspace list — окружения состояния

# git
алиасы: гит, коммит, commit, ветка, branch, мерж, merge, rebase, ребейз, диff, diff
- git status -sb — короткий статус с веткой и отставанием
- git log --oneline --graph --decorate -20 — последние коммиты графом
- git log --oneline @{u}.. — что ещё не отправлено в удалённую ветку
- git diff --stat @{u} — чем отличается от удалённой ветки
- git switch -c <branch> — новая ветка от текущей
- git fetch --prune && git pull --ff-only — обновить без лишних мержей
- git push -u origin HEAD — отправить текущую ветку
- git stash push -m '<текст>' — отложить правки
- git restore --source=HEAD --staged --worktree <file> — вернуть файл как в HEAD
- git blame -L <from>,<to> <file> — кто менял строки
- git bisect start <bad> <good> — поиск коммита, который сломал
- git log --oneline -S'<текст>' -- <file> — когда появилась или пропала строка
- git reflog -20 — куда уходила ветка: вернуть «потерянное» состояние
- git rebase --onto <new-base> <old-base> <branch> — перенести ветку на другую основу
- git cherry-pick -x <hash> — перенести коммит с пометкой об источнике
- git worktree add ../<dir> <branch> — вторая рабочая копия той же истории
- git grep -n '<текст>' $(git rev-list --all | head -50) — поиск по истории

# ssh
алиасы: ssh, scp, sftp, туннель, tunnel, ключ, key, jump, бастион, bastion
- ssh -J <bastion> <user>@<host> — вход через бастион
- ssh -L 8080:127.0.0.1:80 <host> — локальный порт в сторону хоста
- ssh -R 9000:127.0.0.1:9000 <host> — порт хоста в сторону себя
- ssh -o BatchMode=yes <host> 'uptime' — одна команда без интерактива
- ssh-copy-id -i ~/.ssh/<key>.pub <host> — положить ключ на хост
- ssh -G <host> — какие настройки применит ssh для хоста
- scp -3 <host1>:<path> <host2>:<path> — копирование между хостами через себя
- sftp -b - <host> — пакетный режим: get, put, ls, mkdir из stdin
- ssh-keygen -t ed25519 -C '<комментарий>' — новый ключ
- ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-%r@%h:%p -o ControlPersist=5m <host> — общее соединение для следующих команд (кроме Windows)
- ssh -N -D 1080 <host> — SOCKS-прокси через хост
- ssh -o ProxyCommand='ssh -W %h:%p <bastion>' <host> — то же, что -J, для старых клиентов
- ssh-keygen -F <host> и ssh-keygen -R <host> — найти и убрать запись из known_hosts

# jq и yq
алиасы: jq, yq, json, yaml, фильтр, парсить
- jq -r '.items[] | .metadata.name' — имена из массива
- jq -r 'to_entries[] | "\(.key)=\(.value)"' — объект в key=value
- jq -s 'add' a.json b.json — объединить файлы
- jq --arg n <name> '.items[] | select(.metadata.name==$n)' — выбрать по значению
- yq '.spec.template.spec.containers[].image' values.yaml — поле из YAML
- yq -i '.image.tag = "<tag>"' values.yaml — правка YAML на месте

# текстовые фильтры
алиасы: awk, sed, grep, sort, uniq, wc, tail, head, вырезать, посчитать
- grep -rn --include='*.yaml' '<текст>' . — поиск по файлам с номерами строк
- grep -c '<текст>' <file> — сколько строк совпало
- awk '{print $1, $7}' <file> — выбрать столбцы
- awk '$9 >= 500 {n++} END {print n+0}' access.log — посчитать по условию
- sort | uniq -c | sort -rn | head -20 — топ повторов
- sed -n '100,120p' <file> — строки диапазоном
- tail -f <file> | grep --line-buffered '<текст>' — следить с фильтром
- cut -d: -f1 /etc/passwd — поле по разделителю

# диски и файлы
алиасы: df, du, lsblk, место, диск, inode, найти файл, find, tar, архив
- df -h — свободное место по точкам монтирования
- df -i — свободные inode (место есть, а файлы не создаются)
- du -xh --max-depth=1 <dir> | sort -h — что занимает место в папке
- lsblk -f — диски, разделы, файловые системы
- find <dir> -type f -size +100M -printf '%s %p\n' | sort -rn | head — крупные файлы
- find <dir> -type f -mtime -1 — изменённые за сутки
- tar -czf <archive>.tar.gz -C <dir> . — архив папки
- tar -tzf <archive>.tar.gz | head — что внутри архива
- lsof +D <dir> — кто держит файлы в папке

# сеть и dns
алиасы: сеть, network, порт, port, ss, netstat, dig, dns, ping, mtr, traceroute, curl, iptables, nft
- ss -tulpn — кто какие порты слушает и чем
- ss -tn state established '( dport = :443 )' — установленные соединения на 443
- dig +short <name> A — адрес по имени
- dig <name> @<server> +trace — где именно ломается разрешение имени
- dig -x <ip> +short — обратная запись
- curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' <url> — код и время ответа
- curl -sS -H 'Authorization: Bearer <token>' <url> — запрос с заголовком
- mtr -rwzbc 50 <host> — потери и задержки по пути
- ip -br a — адреса интерфейсов коротко
- ip r get <ip> — через какой маршрут пойдёт пакет
- nft list ruleset — правила файрвола (nftables)
- iptables -L -n -v --line-numbers — правила файрвола (iptables)
- tcpdump -ni any port <port> -c 50 -w /tmp/dump.pcap — снять пакеты в файл
- ss -s — сводка по сокетам: сколько соединений в каком состоянии
- conntrack -S — переполнение таблицы соединений (видно по insert_failed и drop)
- getent hosts <name> — как имя разрешает сама система (с учётом /etc/hosts и nsswitch)
- curl -sS --resolve <name>:443:<ip> https://<name>/ -o /dev/null -w '%{http_code}\n' — проверить конкретный адрес, минуя DNS

# процессы и нагрузка
алиасы: процесс, process, нагрузка, load, память, memory, cpu, oom, top, ps
- ps -eo pid,ppid,rss,pcpu,etime,cmd --sort=-rss | head -20 — топ по памяти
- ps -eo pid,pcpu,cmd --sort=-pcpu | head -20 — топ по CPU
- uptime — load average за 1, 5 и 15 минут
- free -h — память и swap
- vmstat 1 5 — очередь, подкачка, ввод-вывод по секундам
- iostat -xz 1 3 — нагрузка на диски по устройствам
- dmesg -T | grep -i -e oom -e 'killed process' — кого убил OOM
- pidstat -p <pid> 1 5 — один процесс по секундам

# nginx
алиасы: nginx, веб-сервер, ingress, прокси, proxy, 502, 504
- nginx -t — проверить конфигурацию
- nginx -T | grep -n 'server_name\|proxy_pass' — конфигурация целиком с подключёнными файлами
- systemctl reload nginx — применить конфигурацию без обрыва соединений
- tail -f /var/log/nginx/error.log — ошибки, следить
- awk '{print $9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn — коды ответов
- awk '$9 ~ /^5/ {print $7}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head — пути с 5xx

# postgresql
алиасы: postgres, postgresql, psql, база, бд, sql, запрос, блокировка, вакуум
- psql -h <host> -U <user> -d <db> -c '\l+' — базы с размером
- psql -c "select pid, now()-query_start as age, state, left(query,80) from pg_stat_activity where state<>'idle' order by age desc limit 20" — активные запросы
- psql -c "select * from pg_locks l join pg_stat_activity a using (pid) where not granted" — кто кого блокирует
- psql -c "select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 20" — крупные таблицы
- psql -c 'select * from pg_stat_replication' — состояние репликации
- pg_dump -h <host> -U <user> -Fc -f <file>.dump <db> — дамп базы
- psql -c "explain (analyze, buffers) <запрос>" — план запроса с фактами
- psql -c "select pid, state, wait_event_type, wait_event, left(query,60) from pg_stat_activity where wait_event is not null" — кто чего ждёт
- psql -c 'select schemaname, relname, n_dead_tup, last_autovacuum from pg_stat_user_tables order by n_dead_tup desc limit 20' — мёртвые строки и когда был автовакуум
- psql -c "select count(*), state from pg_stat_activity group by 2" — сколько соединений и в каком состоянии
- psql -c 'select name, setting from pg_settings where name in (\'max_connections\',\'shared_buffers\',\'work_mem\')' — ключевые настройки

# mysql
алиасы: mysql, mariadb, mysqldump, innodb
- mysql -h <host> -u <user> -p -e 'show processlist' — активные соединения
- mysql -e 'show engine innodb status\G' | sed -n '1,60p' — состояние InnoDB
- mysql -e "select table_schema, round(sum(data_length+index_length)/1024/1024) mb from information_schema.tables group by 1 order by mb desc" — размер баз
- mysql -e 'show replica status\G' — состояние репликации
- mysqldump -h <host> -u <user> -p --single-transaction <db> > <file>.sql — дамп без блокировок

# ansible
алиасы: ansible, плейбук, playbook, инвентарь, inventory, роль
- ansible -i <inventory> <group> -m ping — доступность хостов
- ansible-playbook -i <inventory> <playbook>.yml --check --diff — прогон без изменений
- ansible-playbook -i <inventory> <playbook>.yml -l <host> -t <tag> — часть по хосту и тегу
- ansible-inventory -i <inventory> --graph — группы и хосты
- ansible-vault edit <file>.yml — правка зашифрованного файла

# yandex cloud
алиасы: yc, yandex, яндекс облако, облако, вм, instance, фолдер, каталог
- yc config profile list — профили CLI, активный помечен
- yc --format json compute instance list --folder-id <folder> — машины каталога
- yc compute instance stop --id <id> — выключить машину
- yc compute instance start --id <id> — включить машину
- yc --format json vpc subnet list --folder-id <folder> — подсети
- yc --format json vpc security-group list --folder-id <folder> — группы безопасности с правилами
- yc managed-kubernetes cluster get-credentials <cluster> --external — kubeconfig кластера
- yc --format json billing account list — платёжные аккаунты и баланс

# сертификаты
алиасы: openssl, сертификат, certificate, tls, ssl, срок действия, цепочка
- openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer — срок и кем выдан
- openssl x509 -in <file>.crt -noout -text | head -20 — что внутри сертификата
- openssl x509 -in <file>.crt -noout -enddate — до какого числа действует
- openssl req -new -newkey rsa:2048 -nodes -keyout <name>.key -out <name>.csr -subj '/CN=<host>' — ключ и запрос
- openssl verify -untrusted <chain>.pem <cert>.pem — проверить цепочку

# clickhouse
алиасы: clickhouse, кликхаус, ch, mergetree, партиция, партиции, parts, мутация
- clickhouse-client -h <host> -q "select 1" — проверить соединение
- clickhouse-client -q "select query_id, user, elapsed, formatReadableSize(memory_usage) mem, left(query,80) from system.processes order by elapsed desc" — что выполняется сейчас
- clickhouse-client -q "kill query where query_id='<id>'" — остановить запрос
- clickhouse-client -q "select database, table, formatReadableSize(sum(bytes_on_disk)) size, sum(rows) rows from system.parts where active group by 1,2 order by sum(bytes_on_disk) desc limit 20" — крупные таблицы
- clickhouse-client -q "select table, partition, count() parts from system.parts where active group by 1,2 having parts > 50 order by parts desc" — партиции с множеством кусков (мерджи не успевают)
- clickhouse-client -q "select * from system.mutations where not is_done" — незавершённые мутации
- clickhouse-client -q "select * from system.replicas where is_readonly or absolute_delay > 60" — отставшие или readonly реплики
- clickhouse-client -q "select * from system.replication_queue order by create_time limit 20" — очередь репликации
- clickhouse-client -q "select event_time, query_duration_ms, read_rows, left(query,100) from system.query_log where type='QueryFinish' and event_date=today() order by query_duration_ms desc limit 20" — самые долгие запросы за сегодня
- clickhouse-client -q "select event_time, exception from system.query_log where type='ExceptionWhileProcessing' and event_date=today() order by event_time desc limit 20" — последние ошибки запросов
- clickhouse-client -q "select metric, value from system.asynchronous_metrics where metric like '%Memory%'" — память сервера
- clickhouse-client -q "optimize table <db>.<table> partition '<p>' final" — слить куски партиции (тяжёлая операция)
- clickhouse-client -q "system sync replica <db>.<table>" — дождаться догона реплики

# kafka
алиасы: kafka, кафка, топик, topic, consumer, продюсер, producer, лаг, lag, offset, партиция
- kafka-topics.sh --bootstrap-server <host>:9092 --list — список топиков
- kafka-topics.sh --bootstrap-server <host>:9092 --describe --topic <topic> — партиции, реплики, ISR
- kafka-topics.sh --bootstrap-server <host>:9092 --describe --under-replicated-partitions — партиции без полного набора реплик
- kafka-consumer-groups.sh --bootstrap-server <host>:9092 --describe --group <group> — лаг по партициям
- kafka-consumer-groups.sh --bootstrap-server <host>:9092 --list — группы потребителей
- kafka-consumer-groups.sh --bootstrap-server <host>:9092 --group <group> --topic <topic> --reset-offsets --to-datetime <YYYY-MM-DDTHH:MM:SS.000> --execute — сдвинуть смещения группы (только при остановленных потребителях)
- kafka-console-consumer.sh --bootstrap-server <host>:9092 --topic <topic> --from-beginning --max-messages 10 — посмотреть сообщения
- kafka-console-producer.sh --bootstrap-server <host>:9092 --topic <topic> — отправить сообщения со stdin
- kafka-run-class.sh kafka.tools.GetOffsetShell --bootstrap-server <host>:9092 --topic <topic> — последние смещения партиций
- kafka-configs.sh --bootstrap-server <host>:9092 --entity-type topics --entity-name <topic> --describe — настройки топика (retention, cleanup.policy)
- kafka-log-dirs.sh --bootstrap-server <host>:9092 --describe --topic-list <topic> — сколько занимает топик на брокерах

# redis
алиасы: redis, редис, кэш, cache, ключи, keys, sentinel, валкей, valkey
- redis-cli -h <host> -p 6379 ping — живой ли сервер
- redis-cli -h <host> info memory — память: used_memory_human, maxmemory, политика вытеснения
- redis-cli -h <host> info replication — роль, подключённые реплики, отставание
- redis-cli -h <host> info keyspace — сколько ключей по базам
- redis-cli -h <host> --scan --pattern '<prefix>:*' | head -50 — перебрать ключи без блокировки (не keys *)
- redis-cli -h <host> --bigkeys — самые крупные ключи по типам
- redis-cli -h <host> --memkeys — ключи по занимаемой памяти
- redis-cli -h <host> --latency — задержка ответа
- redis-cli -h <host> slowlog get 20 — последние медленные команды
- redis-cli -h <host> client list | head -20 — подключённые клиенты
- redis-cli -h <host> ttl <key> — сколько ключу жить (-1 без срока, -2 нет ключа)
- redis-cli -h <host> monitor — поток команд (тяжело для нагруженного сервера, ненадолго)

# vault
алиасы: vault, волт, секрет, секреты, secret, kv, token, политика, policy, unseal
- vault status — распечатан ли, версия, кластер
- vault login -method=<userpass|oidc|token> — вход
- vault kv list <mount>/<path> — что лежит в разделе
- vault kv get -format=json <mount>/<path> — секрет целиком
- vault kv get -field=<key> <mount>/<path> — одно поле (удобно в скриптах)
- vault kv put <mount>/<path> <key>=<value> — записать (создаёт новую версию)
- vault kv metadata get <mount>/<path> — версии секрета
- vault kv rollback -version=<n> <mount>/<path> — вернуть прежнюю версию
- vault token lookup — чей токен, какие политики, сколько осталось
- vault token renew — продлить токен
- vault policy read <name> — текст политики
- vault read <mount>/creds/<role> — динамические учётные данные (база, облако)
- vault lease revoke -prefix <mount>/creds/<role> — отозвать выданное
- vault audit list — включённые журналы аудита

# promql
алиасы: promql, prometheus, прометей, метрика, метрики, алерт, alert, запрос к метрикам, rate, irate
- rate(http_requests_total{job="<job>"}[5m]) — запросов в секунду за 5 минут
- sum by (status) (rate(http_requests_total[5m])) — то же с разбивкой по коду ответа
- sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) — доля пятисотых
- histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) — 95-я перцентиль времени ответа
- 100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) — загрузка CPU в процентах
- node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes — доля свободной памяти
- predict_linear(node_filesystem_avail_bytes{mountpoint="/"}[6h], 24*3600) < 0 — место на диске кончится за сутки
- increase(kube_pod_container_status_restarts_total[1h]) > 0 — поды, которые перезапускались за час
- sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"}) — запрошенные ядра по неймспейсам
- up{job="<job>"} == 0 — цели, которые не отвечают
- changes(process_start_time_seconds[1h]) > 0 — процессы, перезапускавшиеся за час
- topk(10, sum by (pod) (rate(container_cpu_usage_seconds_total[5m]))) — самые прожорливые поды
- curl -sG <prometheus>/api/v1/query --data-urlencode 'query=<выражение>' | jq . — выполнить запрос из терминала
