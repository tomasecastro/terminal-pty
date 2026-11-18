# terminal-pty — una terminal local para OpenCode, con un asistente que pregunta primero

[English](./README.md) · **Español**

Plugin de OpenCode que le da al asistente una terminal real donde trabajar: **abre su propio shell**
en tu máquina, lo deja **leerlo** y, si lo autorizás, **ejecutar comandos** ahí.

Nada ocurre sin tu permiso. Leer y escribir son dos capacidades separadas, ambas cerradas por
defecto, se conceden por sesión, se revocan en cualquier momento y desaparecen al cerrar OpenCode.

---

## Qué hace

| Capacidad | Tools | Por defecto |
|---|---|---|
| **Abrir / cerrar** | `terminal_open`, `terminal_kill` | libre |
| **Lectura** | `terminal_pty_read_terminal`, `terminal_pty_terminal_info`, `terminal_pty_wait_for_prompt` | cerrada |
| **Escritura** | `terminal_pty_execute_command` — ejecuta un comando que aprobaste | cerrada |
| **Permisos** | `terminal_pty_access_grant`, `terminal_pty_access_status`, `terminal_pty_access_revoke` | — |
| **Terminal visible** | el panel lateral de OpenCode Desktop, y un comando de paleta que lo abre | libre |

El plugin **no** toma prestada una terminal de OpenCode. Spawnea su propio shell dentro de un PTY
(`node-pty`) y es dueño de los dos extremos, así que escribir no depende de que el host exponga
`experimental.terminal.write`. La terminal del host sigue existiendo, pero solo como **fallback de
lectura** cuando el binding nativo no se puede cargar.

Ese mismo shell se dibuja en OpenCode Desktop: una pestaña **Terminal** en el panel lateral de la
sesión, que se abre con el botón **+** junto a las pestañas del panel o desde la paleta. Escribís ahí,
el asistente lo lee, y lo que ejecuta aparece en la misma pantalla. Ver *La terminal visible*.

El shell corre con tu usuario, tu entorno y tus privilegios. No hay sandbox: lo que te protege es la
barrera de permisos, no un contenedor. Cuando escribís una contraseña en ese shell, el asistente no la
ve: mientras hay un prompt de credencial en pantalla, toda lectura devuelve texto retenido y toda
ejecución queda bloqueada.

## Requisitos

- **OpenCode 2.2.x** (escritorio o TUI). El plugin solo necesita `experimental.terminal.read` del
  host, que exponen todas las versiones actuales.
- **`@lydell/node-pty` 1.2.0-beta.18**, instalado junto a tu configuración de OpenCode (ver
  *Instalación*). Trae binarios precompilados para `win32-x64`, `darwin-arm64/x64` y
  `linux-x64/arm64`, así que no hace falta compilador.
- Un runtime **Bun 1.4 o superior**. OpenCode 2.2.7 embebe Bun 1.4.4, que es con el que se verificó
  el plugin.

  Verificado el 2026-11-12: con Bun **1.3.14** en Windows, `node-pty` arranca el shell y entrega su
  salida, pero escribir en el pipe de entrada de ConPTY falla con `ERR_SOCKET_CLOSED`. El plugin
  sobrevive: carga, informa `engine: host-read-only` y sigue funcionando con la terminal del host, en
  solo lectura. Para escribir hace falta el runtime nuevo.

## Arquitectura

```
src/index.ts        Plugin.define: arma el motor, elige de dónde lee y escribe, loguea el modo
src/tools.ts        las 9 tools; solo adaptadores, ninguna decisión
src/gui/index.ts    el bundle gui-experimental: panel, teclado, botón del panel derecho
lib/gui/protocol.ts el contrato RPC entre el panel y el PTY (terminal-pty.panel)
lib/gui/host.ts     los handlers del RPC: vista, teclas, tamaño, sobre el PTY del plugin
lib/screen.ts       reproduce los movimientos de cursor para que el panel muestre una pantalla legible
lib/terminal-keys.ts una tecla → los bytes que manda una terminal
lib/local-shell.ts  elección de shell por plataforma + LocalShellConnector (spawn del PTY)
lib/local-engine.ts LocalTerminal: open / kill / view / write sobre un SessionManager
lib/session-manager.ts  una sesión: buffer, cegado de credenciales, detección de TUI, log de auditoría
lib/execution-flow.ts   guardas fail-closed para leer y ejecutar
lib/access.ts       capacidades de lectura y escritura, por sesión, alcance del proceso
lib/pty-host.ts     binding perezoso de `node-pty`
script/build-gui.ts genera gui-experimental.cjs (el archivo que evalúa el escritorio)
```

Camino de lectura: bytes del PTY → `BufferBroadcaster` → `snapshot()` → ANSI eliminado → tool.
Camino de escritura: tool → guardas de `runCommand` (permiso, cegado, aprobación) →
`SessionManager.writeAi` → escritura al PTY. La terminal del host solo reemplaza el primer camino
cuando no hay sesión local.

Camino humano: tecla → `lib/terminal-keys.ts` → RPC `terminal-pty.panel.write` →
`SessionManager.writeHuman` → escritura al PTY. El mismo PTY, otra puerta, sin aprobación y sin log.

### Cómo se envía un comando

Un PTY tiene disciplina de terminal, no es un archivo. **ConPTY no traduce LF a CR**: escribir `\n`
inserta una línea en el buffer de PSReadLine (el prompt de continuación `>>`) en vez de ejecutar.
`lib/enter.ts` es el único lugar que decide:

| Destino | Terminador |
|---|---|
| Shell local en Windows | `\r` |
| Shell local en macOS/Linux | `\n` |
| Sesión SSH (shell POSIX del otro lado) | `\n` |

El terminador se aplica dos veces a propósito: `runCommand` entrega la línea terminada y
`SessionManager.writeAi` la re-normaliza para la sesión, así ningún llamador puede reintroducir el
bug. Las pulsaciones humanas no se reescriben: xterm manda los bytes correctos y el plugin los escribe
tal cual.

### Por qué los shells de PowerShell arrancan "en silencio"

La predicción en línea de PSReadLine pinta junto al prompt, en gris itálica, una sugerencia tomada del
**archivo de historial compartido de PowerShell**, en la primera tecla. En una terminal manejada por
un asistente eso es ruido y una fuga de privacidad: la sugerencia es un comando que corrió otra sesión
y termina en el buffer que el asistente lee. El plugin arranca `pwsh`/`powershell` con
`-NoExit -Command "try { Set-PSReadLineOption -PredictionSource None } catch { }"`, que aplica solo a
ese PTY y deja intactos tus propios shells. `cmd.exe` no se toca.

## Instalación

El plugin es un directorio. Hay dos formas de registrarlo, y ambas son solo configuración: no se
modifica ningún archivo de OpenCode.

### Opción A — descubrimiento por carpeta (sin configuración)

```powershell
# Windows (global, aplica a todos los proyectos)
Copy-Item -Recurse .\src\opencode\.opencode\plugin\terminal-pty "$env:USERPROFILE\.config\opencode\plugin\terminal-pty"

# macOS / Linux
cp -R src/opencode/.opencode/plugin/terminal-pty ~/.config/opencode/plugin/terminal-pty
```

Después instalá el binding nativo donde el plugin lo pueda resolver:

```powershell
cd "$env:USERPROFILE\.config\opencode"
npm i @lydell/node-pty
```

Verificá:

```bash
opencode plugin list
```

```
ID       VERSION  SOURCE
terminal-pty  local    C:\Users\<vos>\.config\opencode\plugin\terminal-pty
```

La carpeta **debe** llamarse `plugin` (singular). Las versiones anteriores no descubren `plugins`.

El descubrimiento por carpeta no pasa opciones, así que el acceso queda deshabilitado. Activalo con
la variable de entorno de **Configuración**.

### Opción B — declararlo con opciones (recomendado)

En tu `opencode.json` (o `opencode.jsonc`), agregá el directorio a la lista de plugins. Usá la clave
que acepte tu versión: `plugin` en la 2.2.7, `plugins` en el fork.

```json
{
  "plugin": [
    {
      "package": "C:/Users/<vos>/.config/opencode/plugin/terminal-pty",
      "options": {
        "access": {
          "enabled": true,
          "allowlist": ["ls", "cat", "grep", "tail"]
        }
      }
    }
  ]
}
```

El destino debe ser un **directorio**, no un archivo. Si apuntás a un archivo, se ignora con
`configured plugin path must be a directory`.

Reiniciá OpenCode después de cambiar la configuración. El log muestra qué motor arrancó:

```
msg="terminal-pty plugin loaded" engine=local-pty write=true shell="C:\Program Files\PowerShell\7\pwsh.exe"
```

## Configuración

| Clave | Tipo | Por defecto | Significado |
|---|---|---|---|
| `access.enabled` | booleano | `true` | Si el asistente puede **pedir** acceso. Nunca concede nada por sí solo: leer y escribir siguen necesitando tu aprobación explícita por sesión. Ponelo en `false` para silenciarlo del todo |
| `access.allowlist` | string[] | `[]` | Comandos iniciales que se saltan la aprobación por comando, una vez concedida la escritura |

Si instalás por descubrimiento de carpeta y no podés pasar opciones, usá la variable de entorno:

```powershell
$env:SSH_PTY_ACCESS = "1"   # equivale a access.enabled: true
```

O declarala en el entorno que inicia OpenCode. El nombre se mantiene por compatibilidad con versiones
anteriores del plugin.

## La terminal visible

En OpenCode Desktop el plugin también dibuja su shell. Es **el mismo PTY** que el asistente lee y en
el que escribe: un solo shell, dos puertas.

### Abrirla

- **Panel derecho**: el botón **+** antes de las pestañas del panel lateral lista **Terminal**. Elegilo
  y la pestaña se abre a la derecha, con el foco.
- **Paleta de comandos**: `Abrir terminal`. No trae atajo por defecto, para no chocar con los de la
  app; si querés uno, asignalo en Ajustes › Atajos.

La pestaña es por sesión: muestra el shell de la sesión que estás mirando y vuelve cuando volvés a
esa sesión.

### Escribir en ella

Clic en cualquier parte de la terminal y escribí. Por defecto es **modo línea**: los caracteres
quedan en la línea local bajo la pantalla y nada llega al PTY hasta Enter (ver *Modo línea y modo
raw*). En **modo raw**, lo que escribís llega al PTY byte por byte:

| Tecla | Se envía |
|---|---|
| Letras, números, símbolos | el carácter tal como lo compone tu distribución |
| Enter | `\r` (el byte que espera una consola Windows para ejecutar una línea) |
| Backspace, Tab, Escape, flechas, Home/End, PgUp/PgDn, Delete, Insert | las secuencias de terminal de siempre |
| Ctrl + letra | el código de control (`Ctrl+C` → `\u0003`) |
| Alt + tecla | `ESC` + tecla; los caracteres de AltGr se escriben, no se convierten en códigos de control |
| Pegar | el portapapeles, con todo fin de línea normalizado a `\r` (modo raw); en modo línea llena la línea local |

Tus pulsaciones no se loguean, no se difunden y no se auditan: van por
`SessionManager.writeHuman`, el camino reservado para la persona frente a la pantalla. Por eso tampoco
piden aprobación — aprobar lo que vos mismo escribís sería teatro. Los comandos del asistente van por
el camino con barreras, más abajo.

### Modo línea y modo raw

Todo panel arranca en **modo línea**, y la barra sobre el input lo dice. Armás el comando en la línea
local; el PTY no escucha nada mientras escribís, así que el eco del shell no puede convertir `abc` en
`a`, `aa`, `abc`. **Enter** envía la línea entera una sola vez. `Ctrl+C` y `Escape` descartan la línea
local sin enviarla, y `Tab` inserta un tabulador en vez de mover el foco.

El botón al lado de la etiqueta pasa a **modo raw** y vuelve; nombra el modo al que va, así que `Raw`
siempre está a un clic y `Line` te devuelve. Usá raw para programas de pantalla completa (`vim`,
`htop`, `less`) y prompts que quieren las teclas apenas llegan: ahí cada tecla se envía una vez, como
en una terminal normal. Cambiar de modo limpia la línea local en ambos sentidos — una línea que nadie
puede ver no debe dejar al asistente esperando.

- **Pegar es una sola inserción.** En modo línea el portapapeles se vuelve texto en la línea local y
  Enter lo envía una vez, con `\r`. En modo raw el portapapeles llega al PTY una vez: el panel
  convierte el atajo de pegado de la ventana en una sola escritura, así que el pegado propio del shell
  no inserta una segunda copia.
- **Las credenciales se enmascaran y no se loguean.** Mientras el detector de credenciales ve un
  prompt, la línea local pinta discos en vez de caracteres; la pantalla sigue mostrando el prompt,
  porque sos vos quien tiene que leerlo. La contraseña no llega al log de auditoría ni a la lectura
  del asistente: el buffer que ve la IA queda retenido mientras el prompt esté en pantalla.
- **Un solo escritor a la vez.** Si empezás a escribir, el asistente espera: un comando que ya tenía
  aprobado se encola en vez de caer encima de tu línea, y se libera cuando la línea se cierra —Enter,
  `Ctrl+C`, `Escape` o input vacío— en orden de aprobación. Lo que manda el panel llega al PTY en el
  orden en que lo produjiste, así que un envío nunca adelanta a una escritura en curso.

### Qué ve el asistente

El shell en el que escribís es el que lee `terminal_pty_read_terminal`. Nada se comparte implícito: el
asistente sigue necesitando el permiso por sesión que describe *Cómo se usa*, y sigue necesitando tu
aprobación para cada comando salvo que esté en la allowlist.

El panel y el asistente leen el mismo buffer con una diferencia importante: mientras hay un prompt de
credencial en pantalla, el asistente recibe texto retenido y el panel te sigue mostrando tu prompt. La
contraseña la escribís vos; ocultártela solo te haría escribir a ciegas.

### La aprobación es de la app, no del plugin

El plugin nunca dibuja un diálogo propio. Cuando necesita tu decisión llama a
`context.permission.assert`, y OpenCode la muestra en la misma superficie nativa de aprobación que usa
para `bash` y `edit`. Dos consecuencias que conviene saber:

- **Un pedido que ves es el pedido de la app.** Si se ve como cualquier otro pedido de permiso de
  OpenCode, está funcionando como debe.
- **Si tu configuración de `permission` ya permite ese tipo de acción, no aparece ningún pedido.** Eso
  lo decide el mecanismo nativo, no el plugin salteándose un paso: el plugin preguntó y la app
  respondió. Para volver a ver el pedido, quitá la regla de `permission` que lo permite (o ponela en
  `ask`).

#### Las dos claves de permiso

El plugin pide dos acciones, y cada una tiene su clave en el bloque `permission` de OpenCode:

| Acción | Clave | Qué protege |
|---|---|---|
| `terminal_pty.access` | `"terminal_pty.access": "ask"` | el permiso por sesión: `terminal_pty_access_grant` no puede entregar lectura ni escritura sin tu respuesta |
| `terminal_pty.execute` | `"terminal_pty.execute": "ask"` | cada comando que el asistente manda por `terminal_pty_execute_command` |

El valor recomendado es `ask` para las dos. `ask` — y no `deny` — es lo que mantiene las tools
usables: el pedido te llega en la superficie de aprobación y decidís llamada por llamada. Van en el
bloque `permission` de tu configuración global, `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "permission": {
    "read": "allow",
    "edit": "allow",
    "terminal_pty.access": "ask",
    "terminal_pty.execute": "ask"
  }
}
```

- **El diálogo es de OpenCode.** No hay una segunda ventana con otro aspecto: aprobar un permiso es
  la misma interacción que aprobar `bash`.
- **Revocar sigue sin fricción.** `terminal_pty_access_revoke` nunca pregunta, aunque las dos claves
  estén en `ask`; quitar acceso no debería requerir confirmación.
- **Volver al comportamiento anterior.** Quitá las dos claves, o ponelas en `"allow"`, y reiniciá
  OpenCode. El host aprueba entonces ambas acciones por su cuenta y los pedidos dejan de aparecer:
  el plugin sigue preguntando, la app responde por vos. Es como se comportaba el plugin antes de
  declarar estas claves, y el resto de `permission` no cambia.

### Lo que no hace

- **No renderiza programas de pantalla completa.** `vim`, `htop` o `less` escriben en la pantalla
  alternativa; el panel avisa que hay un programa de pantalla completa en vez de pintar basura. El
  asistente los lee por las tools, y la pestaña te dice que están ahí.
- **Es una pantalla de texto, no un emulador.** Se reproducen movimientos de cursor, borrados y
  reescrituras de línea (que es lo que mantiene legible el tipeo); no hay colores, ni mouse, ni
  regiones de scroll.
- **El scrollback del panel son las últimas 400 filas.** El PTY guarda más; el panel pide una ventana
  chica para seguir respondiendo.
- **El shell toma su tamaño al abrir la pestaña y cuando el panel cambia de tamaño**, a partir de la
  caja renderizada. Un redimensionado durante un comando largo también le llega, pero la estimación es
  en caracteres, así que puede errarle por una columna.

### El bundle

El panel viaja como `gui-experimental.cjs` en la raíz del plugin, el archivo CommonJS que el escritorio
evalúa en cada ventana. Se compila desde `src/gui/`:

```bash
bun script/build-gui.ts
```

Volvé a compilarlo si cambiás algo bajo `src/gui/` o los módulos que importa (`lib/gui/`,
`lib/screen.ts`, `lib/terminal-keys.ts`). Sin ese archivo el plugin funciona exactamente como antes de
que existiera el panel: las tools, los permisos y las aprobaciones no dependen de él.

La app resuelve el bundle desde el directorio del plugin: `gui-experimental.cjs` en la raíz mientras el
manifiesto siga guardado como `package.json.disabled` (la convención del host para un directorio sin
`exports`), o a través de `exports["./gui-experimental"]` de ese manifiesto si lo activás. Las dos
formas apuntan al mismo archivo, así que el panel sobrevive a cualquiera de las dos.

## Cómo se usa

1. **Pedile una terminal.** Decile "abrí una terminal acá" o "dame un shell". El asistente llama
   `terminal_open` y te devuelve la sesión, el shell y el directorio:

   ```json
   { "sessionID": "ses_abc", "pid": 4312, "shell": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
     "cwd": "C:\\Users\\vos", "engine": "local-pty" }
   ```

   Abrir dos veces devuelve el mismo shell: no se spawnea nada más.

2. **La lectura sigue cerrada.** Si le pedís que lea, responde:

   ```
   Terminal access is disabled. The human must enable `access.enabled` in the plugin options.
   ```

   y, una vez habilitado el acceso:

   ```
   No read permission for this session. The human must grant it with `terminal_pty_access_grant`.
   ```

3. **Concedé lo que quieras.** Decile "leé esta terminal" o "podés ejecutar comandos acá". El
   asistente llama `terminal_pty_access_grant` y OpenCode te muestra el pedido de aprobación.

   | Modo | Concede |
   |---|---|
   | `read` | solo lectura |
   | `read-write` | lectura y ejecución de comandos |

4. **Trabajá.** Con `read` concedido, el asistente lee la pantalla. Con `read-write`, cada comando te
   sigue pidiendo aprobación salvo que esté en la allowlist.

5. **Revocá cuando quieras.** `terminal_pty_access_revoke` tiene efecto inmediato y nunca pide
   aprobación. Usá `capability: "write"` para conservar la lectura y cortar la ejecución.

6. **Cerrá el shell.** `terminal_kill` destruye el PTY y su scrollback; nunca pide aprobación, igual
   que revocar. Cerrar OpenCode mata todas las sesiones con el proceso.

## Modelo de seguridad

| Propiedad | Comportamiento |
|---|---|
| Cerrado por defecto | Ni lectura ni escritura hasta que lo permitas. Instalar el plugin no concede nada |
| Por sesión | Dos sesiones tienen permisos y shells independientes |
| Alcance del proceso | Los permisos viven en memoria; cerrar OpenCode los descarta, incluso con la sesión reanudada |
| Sin límite de tiempo ni de comandos | Dura mientras viva el proceso, no más |
| Revocable al instante | Revocar nunca pide aprobación y aplica al comando siguiente |
| Escribir implica leer | No podés ejecutar lo que no podés ver |
| Leer no implica escribir | Conceder lectura nunca habilita la ejecución |
| El cegado manda | Con lectura concedida, un prompt de contraseña sigue devolviendo texto retenido; con escritura concedida, bloquea la ejecución |
| Comandos encadenados nunca se autoaprueban | `;`, `&&`, `$(...)`, `>`, `|`, backticks siempre requieren aprobación |
| Las pulsaciones no se loguean | La entrada humana va al PTY y nunca se registra |
| El shell local no es un sandbox | Corre con tus privilegios, tu entorno y tus archivos. La barrera es el permiso, no el proceso |

## Limitaciones conocidas

- **Un shell por sesión.** `terminal_open` es idempotente; la segunda llamada devuelve el mismo
  shell. Si querés uno limpio, primero `terminal_kill`.
- **El panel necesita OpenCode Desktop.** Es una contribución de GUI (`gui-experimental`); el TUI no
  tiene panel lateral donde ponerlo. Las tools funcionan igual en los dos.
- **El panel no emula una terminal.** Reproduce movimientos de cursor y borrados de línea sobre las
  últimas 400 filas; un programa de pantalla completa se informa, no se dibuja. La copia exacta de la
  pantalla, los colores y el soporte de mouse son de la terminal de la app, no de esta vista.
- **El fallback del host es solo lectura.** En un runtime donde `node-pty` no carga, el plugin
  informa `engine: "host-read-only"`, lee la terminal del host y responde
  `Writing to the terminal is not available in this host` al intentar ejecutar.
- **Sin timeout por comando.** Un comando colgado ocupa la sesión hasta que la mates.
- **`pid` es `null` en Windows.** `node-pty` informa `0` en sesiones ConPTY, así que `terminal_open`
  devuelve `null` en lugar de un número inventado; el shell y el id de sesión lo identifican.
- **La lectura es una pantalla aplanada, no renderizada.** PSReadLine repinta la línea en cada tecla,
  así que un snapshot puede mostrar los renders intermedios de tu propio comando (prefijos repetidos,
  `>>` mientras una comilla está abierta). El último repintado es el estado actual; ya no puede
  aparecer texto ajeno, porque la predicción de historial está desactivada en el shell del plugin.
- **La allowlist es comodidad, no una jaula.** Igual se ejecuta con los privilegios de tu shell.
- **Windows necesita un Bun moderno.** Bun 1.3.x no puede escribir en ConPTY; el plugin degrada en
  lugar de crashear.

## Desinstalación

1. Quitá la entrada de `opencode.json`, **o** borrá la carpeta:

   ```powershell
   Remove-Item -Recurse "$env:USERPROFILE\.config\opencode\plugin\terminal-pty"
   ```

2. Reiniciá OpenCode. Se comporta exactamente igual que antes de instalarlo.

Si querés ser explícito, revocá el acceso antes de quitarlo; borrar la carpeta también lo termina,
porque los permisos viven solo en memoria y todo shell spawneado muere con el proceso.

## Desarrollo

```bash
cd src/opencode/.opencode/plugin/terminal-pty
bun test                     # 222 tests, 0 fallos
bun script/build-gui.ts      # regenera gui-experimental.cjs
```

La suite es lógica pura más un PTY en memoria: sin binario nativo, sin host y sin servidor SSH. La
elección de shell se prueba con un sistema de archivos inyectado, así que corre igual en cualquier
plataforma. El panel se prueba cargando el bundle compilado como lo carga el escritorio: un texto
CommonJS, evaluado con un `require` que solo responde los módulos que provee el host de la ventana, y
accionando su ciclo de lectura y su teclado.

Lo que la suite no puede cubrir es la app: que la pestaña caiga en el panel lateral, que la aprobación
aparezca donde la app pone las suyas y que el navegador entregue las teclas. Eso necesita un OpenCode
Desktop corriendo con el plugin instalado, y queda listado como verificación pendiente de runtime en
`Documentacion/opencode/specs/003-plugin-terminal-pty/`.

Especificación, plan, tareas y estado verificado en
`Documentacion/opencode/specs/003-plugin-terminal-pty/`.
