# Wiki OpsDeck

Практическое руководство: возможности 0.9.2 и изменения ветки dev (светлая тема и назначаемое переключение проектов). Новые функции dev появятся в установленном приложении после следующего выпуска. OpsDeck — локальное настольное приложение: источники и серверы добавляются в соответствующих разделах, а кнопка **!** в каждом разделе открывает встроенную подсказку.

## С чего начать

1. [Установка и первый запуск](getting-started.md) — требования, установка, модули и окружения.
2. [Подключения](connections.md) — SSH, Kubernetes, веб-панели и алерты, базы, Yandex Cloud, MikroTik, хранилища паролей.
3. [Работа в OpsDeck](usage.md) — терминал, AI, IDE, заметки, мониторинг и перенос настроек.
4. [Локальный ИИ и OpenCode](ai.md) — встроенная модель, внешний сервер и JSON-конфигурация OpenCode.

## Как связаны разделы

| Источник | Где используется |
|---|---|
| Keyring, KeePass, Passbolt, gopass | Данные входа SSH, веб-панелей, баз данных и MikroTik |
| SSH-профили | Терминал, файлы на хостах, мониторинг и SSH-туннели баз данных |
| Kubeconfig | Кластеры и ресурсы Kubernetes |
| Веб-панели и источники алертов | Просмотр веб-интерфейсов и опрос событий |
| Профиль yc CLI | Ресурсы Yandex Cloud |

Разделы включаются кнопкой **⊞** в левой колонке. При новой установке включены Терминал, Kubernetes, SSH, KeePass и Заметки. Открывать все разделы сразу необязательно.

Дополнительно: [обзор возможностей и сборка из исходников](reference.md), [сообщить о проблеме](https://github.com/LeoAlecksey/opsdeck/issues).

## Подробно по каждому разделу

- [Терминал и AI](module-terminal.md)
- [Kubernetes](module-k8s.md)
- [Веб-панели](module-web.md)
- [Алерты](module-alerts.md)
- [Сеть и DNS](module-net.md)
- [Yandex Cloud](module-yc.md)
- [Файлы на хостах](module-sftp.md)
- [Мониторинг хостов](module-monitor.md)
- [SSH](module-ssh.md)
- [IDE: код и git](module-code.md)
- [Базы данных](module-db.md)
- [Заметки](module-notes.md)
- [Задачи и напоминания](module-tasks.md)
- [KeePass](module-vault.md)
- [gopass](module-gopass.md)
- [Passbolt](module-passbolt.md)
- [ИИ-агент](module-agent.md)
- [MikroTik](module-winbox.md)
- [Настройки](module-settings.md)

[Установка, сборка, ограничения и технический справочник](reference.md)
