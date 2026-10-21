# REEL CAPITAL — onboarding inicial

Actualizado: 20 de octubre de 2026. Estado: alcance principal confirmado por el usuario. Stack decidido: SvelteKit + TypeScript + Effect sobre Cloudflare. Instrumentos iniciales: acciones (equities) y opciones, con cadena de opciones para seleccionar contratos. Órdenes exclusivamente de mercado. Cada cliente utiliza su propia API key de TradeStation. Lanzamiento inicial en SIM y modo real posterior. El usuario confirma que ya dispone de API key y acceso SIM para desarrollo. Los servicios concretos de Cloudflare siguientes son propuestas.

Acceso exclusivamente por invitación, con perfiles creados por el administrador. Operaciones de apertura por compra y cierre por venta durante el horario regular del mercado. Posiciones, cancelación de órdenes pendientes, cierres parciales/totales e historial incluidos. Diseño minimalista, casi brutalista, exclusivamente en tonos oscuros, grises neutros y blanco, según la imagen aportada por el usuario. Los demos orientan la estructura y las interacciones; gráficos y P&L permanecen ocultos durante la operación. Dominio `thereelcapital.com` y cuenta Cloudflare confirmados por el usuario. Piloto privado con unos pocos clientes iniciales.

Riesgo confirmado: máximo de **dos posiciones abiertas simultáneamente** y **tres entradas nuevas por cliente y día de mercado**. Stop loss inicial de **30%**, configurable por el administrador solo para nuevas posiciones. Salidas parciales de 30%, 20% y cinco pasos de 10% sobre la cantidad original. Trailing ajustable por el cliente, inicialmente **10%**, habilitado tras vender **70%** de la posición original; el administrador configura ese umbral por cliente. El límite diario bloquea nuevas compras de apertura, no las ventas de cierre ni las cancelaciones.

## Producto confirmado

Aplicación web para clientes que quieren operar acciones y opciones en sus propias cuentas de TradeStation desde una interfaz sencilla. Cada cliente configura su API key, autoriza la conexión e introduce el símbolo o selecciona un contrato desde la cadena de opciones. La aplicación calcula la cantidad de entrada a partir del SIZE de ese cliente y de la cotización obtenida de TradeStation; el cliente envía la orden de mercado y consulta su resultado sin abrir el terminal de trading del bróker.

Cada cliente aporta su configuración API y completa la autorización requerida por el bróker. «Conectar con TradeStation» representa el paso de autorización con esa API propia; no una segunda modalidad con una API compartida de REEL CAPITAL. Cada cliente decide y envía sus propias órdenes; sus cuentas, credenciales, órdenes y posiciones deben estar aisladas de las de otros clientes.

El cliente conserva su cuenta de TradeStation y utiliza REEL CAPITAL como interfaz para operar; no se exige abrir una nueva cuenta dedicada. Conciliar siempre con las posiciones y ejecuciones reales del bróker, también al conectar una cuenta que ya tenga actividad.

## Acceso y perfiles

- El administrador crea el perfil del cliente y habilita su incorporación por invitación. No hay registro público ni creación de clientes a partir de un login de TradeStation desconocido.
- La invitación debe estar vinculada al perfil, expirar y poder utilizarse una sola vez. El cliente activa su acceso y conecta su API propia.
- Separar el rol administrador, que gestiona perfiles, acceso, aumentos de SIZE, stop loss y umbral vendido para habilitar trailing por cliente, del rol cliente, que configura su conexión, elige el porcentaje de trailing y opera sus cuentas. Validar los permisos en el servidor.
- Al desactivar un perfil, revocar su acceso a la aplicación y sus sesiones. No enviar ni cancelar órdenes del bróker como efecto implícito de ese cambio.

### Panel de administración completo

Por decisión del usuario, entregar el panel de administración completo para el alcance de REEL CAPITAL desde el piloto. No reducirlo a un formulario de alta y configuración.

- **Vista general:** clientes y estado de acceso, conexiones a TradeStation, posiciones abiertas, órdenes pendientes, consumo de límites y errores operativos. Identificar cliente, cuenta y modo en cada consulta.
- **Clientes e invitaciones:** crear y editar perfiles, consultar su activación, enviar o reenviar invitaciones, revocar invitaciones pendientes y activar o desactivar accesos. Mantener los permisos y la verificación de identidad en el servidor.
- **Detalle por cliente:** configuración vigente, cuentas vinculadas, modo habilitado, estado y última sincronización de la conexión, posiciones, órdenes y actividad. Mostrar metadatos de conexión sin revelar secretos ni tokens.
- **Configuración individual:** SIZE inicial de US$20,000 con aumentos únicamente; stop inicial de 30%; umbral vendido inicial de 70% para habilitar trailing. Mostrar valores actuales y cambios, preservar los parámetros de posiciones existentes y mantener fijos los límites de dos posiciones simultáneas y tres entradas nuevas diarias.
- **Seguridad y accesos:** consultar y revocar sesiones, gestionar permisos y dar seguimiento a recuperación de acceso mediante los controles de identidad y autenticación fuerte definidos. Exigir autenticación reciente para cambios sensibles y registrar al administrador responsable.
- **Seguimiento operativo e historial:** buscar y filtrar órdenes, ejecuciones, posiciones, errores y eventos de conexión por cliente, cuenta, modo, fecha y estado; consultar sus detalles. Conservar la presentación sin gráficos ni P&L acordada para la aplicación.
- **Auditoría:** consultar los cambios administrativos con actor, cliente afectado, fecha y valores anteriores/nuevos cuando corresponda, además de eventos de acceso e invitaciones; excluir credenciales y tokens.
- Aplicar la misma estética monocromática y los estados de carga, vacío, error y confirmación del resto de la aplicación. El modo real permanece bloqueado en servidor durante el piloto SIM; disponer del panel completo no adelanta su habilitación.

### Autenticación y recuperación

Decisión confirmada del usuario: correo verificado, passkey con huella/Face ID/PIN y códigos de recuperación de un solo uso. Exigir autenticación multifactor tanto a clientes como al administrador. La incorporación sigue limitada a perfiles creados por el administrador.

**Solución de autenticación confirmada: Better Auth**, integrado con SvelteKit sobre Cloudflare Workers y persistencia en D1. Usar sus componentes de passkeys, verificación de correo, sesiones y administración, e integrar la recuperación con códigos de respaldo en el flujo acordado. La aplicación debe imponer el acceso solo por invitación y comprobar la autenticación fuerte en servidor antes de permitir operar; instalar los plugins por sí solo no acredita esas reglas.

Better Auth es una biblioteca de código abierto con licencia MIT que alojamos y mantenemos en nuestra infraestructura. Su elección no incluye un servicio de envío de correos: **el proveedor de correo para invitaciones y códigos sigue pendiente**. La licencia gratuita tampoco elimina los posibles costes de Workers, D1 y correo. El panel administrativo completo de REEL CAPITAL y sus controles operativos forman parte de la aplicación.

- Verificar el correo asociado a la invitación mediante un código de un solo uso, con vencimiento, límite de intentos y protección contra reenvíos abusivos. Verificar un correo no debe habilitar operaciones por sí solo.
- Usar **passkey con verificación de usuario obligatoria** (huella, Face ID o PIN del autenticador), vinculada al perfil y al dominio de la aplicación. Un código enviado al correo por sí solo no satisface el requisito de MFA ni permite operar.
- Exigir y comprobar en servidor la verificación de usuario (`userVerification: required`), challenge, origen y RP ID. Utilizar una implementación mantenida de WebAuthn; no crear un esquema criptográfico propio.
- Entregar códigos de recuperación de alta entropía, de un solo uso, mostrados una vez y almacenados como hashes. El flujo de recuperación debe comprobar el control de la cuenta, revocar sesiones anteriores y exigir configurar de nuevo la autenticación fuerte antes de operar. Un restablecimiento por correo no puede quitar MFA automáticamente.
- Exigir autenticación reciente para modificar factores, credenciales API, roles o configuración administrativa de riesgo. Aplicar límites a intentos, sesiones revocables y registros de cambios sin secretos.
- Mantener OAuth de TradeStation separado del acceso a REEL CAPITAL: conectar una API no crea un perfil, sustituye MFA ni concede rol de administrador.
- El cierre o vencimiento de la sesión del navegador no debe desactivar stops o trailing que protegen posiciones abiertas. Su ejecución depende del servicio o del bróker, no de una pestaña autenticada.

## Recorrido mínimo

1. **Acceder y conectar:** activar el perfil creado por el administrador mediante su invitación, iniciar sesión, configurar la API propia y autorizar el acceso en TradeStation. Vincular la conexión al perfil existente correcto.
2. **Seleccionar modo, instrumento y cuenta:** SIM inicialmente; real disponible en una etapa posterior. Elegir acciones u opciones y una cuenta autorizada compatible. Mantener modo y cuenta visibles en el terminal.
3. **Preparar:** para acciones, buscar el ticker; para opciones, buscar el subyacente y seleccionar un contrato de la cadena. Obtener automáticamente la cotización de TradeStation y mostrar, como datos de solo lectura, el precio o prima, el SIZE del cliente y la cantidad de entrada calculada.
4. **Definir orden:** comprar para abrir una posición o vender para cerrar una posición larga existente. En opciones, BUY TO OPEN / SELL TO CLOSE; en acciones, usar las instrucciones de compra/venta correspondientes del bróker. Mostrar siempre tipo MARKET; el formulario no solicita un precio límite.
5. **Enviar:** mostrar cuenta, entorno, instrumento, acción, SIZE aplicado, cantidad calculada y condiciones para que el cliente confirme desde REEL CAPITAL. Verificar nuevamente en servidor la configuración vigente y la cotización antes del envío; si cambia la cantidad mostrada, actualizar la preparación sin enviar silenciosamente una cantidad diferente.
6. **Gestionar:** consultar hasta dos posiciones abiertas e historial, cancelar órdenes aún pendientes y cerrar la posición seleccionada mediante la barra porcentual o ALL OUT. Cuando las ventas confirmadas alcancen el umbral configurado, permitir ajustar y activar manualmente el trailing sobre el remanente. Mostrar identificador, estado y cantidad ejecutada; recuperar órdenes y posiciones al volver a entrar. Mantener gráficos y P&L ocultos en el terminal.

La cantidad de entrada se calcula automáticamente: acciones para equities y contratos enteros positivos para opciones. Validar símbolo, cantidad y precisión admitida por el bróker y la cuenta. Los cierres parciales usan los botones porcentuales del demo, limitados al remanente disponible. Los futuros quedan fuera del alcance inicial.

### SIZE por cliente

- Cada perfil empieza con un SIZE base de **US$20,000 por entrada**. El administrador puede aumentarlo individualmente para ese cliente. Los cambios de un perfil no modifican el SIZE de otros clientes.
- Solo se admiten aumentos sobre el valor vigente. No hay SIZE DOWN, reducciones de −25%/−50%, restablecimientos a un importe inferior ni cambios de SIZE realizados por el cliente.
- Guardar el SIZE en servidor como parte de la configuración del cliente. Validar rol de administrador e incremento del valor, y registrar actor, cliente, importe anterior, importe nuevo y fecha del cambio.
- Aplicar los aumentos a nuevas entradas. Conservar en cada intención y orden el SIZE utilizado; no recalcular órdenes ya enviadas ni posiciones abiertas por un cambio administrativo.
- Calcular cantidad usando el ask vigente de TradeStation. Para opciones: `floor(SIZE / (ask × multiplicador validado del contrato))`. Para acciones, dividir SIZE entre ask y redondear hacia abajo al incremento de cantidad admitido. No asumir que todos los contratos tienen el mismo multiplicador.
- Si faltan cotización válida, multiplicador o reglas de cantidad, o el importe no alcanza para la unidad mínima negociable, bloquear la entrada y explicar el motivo; no sustituir la cotización por un valor manual.
- El SIZE es el importe objetivo para dimensionar la entrada. Como las órdenes son MARKET, el costo finalmente ejecutado puede diferir del estimado y superar ese importe; usar fills confirmados para registrar cantidades y precios reales.
- Los cierres parciales y totales siguen disponibles: reducir una posición existente no cambia el SIZE configurado para nuevas entradas.

### Límite diario y stop loss

- Máximo fijo de **tres entradas nuevas por cliente, modo y día de mercado**, compartido entre las cuentas conectadas de ese cliente. No es un límite de stops ni de órdenes de salida. No es editable por el cliente ni un parámetro configurable por el administrador.
- Máximo de **dos posiciones abiertas simultáneamente por cliente y modo**, compartido entre sus cuentas. Reservar capacidad para las aperturas en curso; una tercera apertura no puede adelantarse a fills pendientes. Liberar capacidad únicamente al confirmar una cancelación sin ejecución o el cierre completo de la posición, no al pulsar ALL OUT.
- Una compra intencional que abre o incrementa una posición consume una entrada al recibir su primer fill. Sus fills parciales y reintentos de la misma intención no consumen entradas adicionales. Una nueva compra intencional, incluso del mismo símbolo, sí cuenta por separado.
- Reservar una entrada de forma atómica antes de enviar la compra, de modo que las solicitudes concurrentes no superen tres entre entradas consumidas y reservadas. Liberar la reserva solo tras confirmar rechazo o cancelación sin fills. Una orden parcialmente ejecutada conserva su entrada; un resultado desconocido conserva la reserva hasta conciliar.
- Al alcanzar el límite, bloquear nuevas compras de apertura. Permitir cancelaciones, cierres parciales/totales y cierres por stop, sujetos a horario, permisos y estado del bróker. Vender o cerrar una posición no devuelve la entrada consumida.
- Persistir el contador por cliente y modo, asociado a la fecha de sesión del calendario de mercado. Recargar, reconectar, cambiar de cuenta o reiniciar el servicio no lo restablece. La siguiente sesión usa su propio contador; conservar los anteriores para auditoría.
- El stop loss predeterminado es **30% por posición**. El administrador puede configurar el porcentaje del cliente; el cliente lo ve como dato de solo lectura. Validar el porcentaje y auditar actor, valores anterior/nuevo y fecha de cada cambio.
- Por decisión del usuario, aplicar cambios administrativos de stop únicamente a nuevas posiciones y guardar el porcentaje aplicado a cada una. Las posiciones abiertas conservan su stop existente.
- Calcular el umbral desde el precio medio de compra realmente ejecutado: `precio medio × (1 − porcentaje / 100)`. Para opciones, usar la prima media de los fills del contrato; para acciones, su precio medio por acción. No basarse en la prima de referencia previa a la compra.
- Al alcanzarse el umbral con una cotización ejecutable y vigente, iniciar el cierre a mercado del remanente. Coordinarlo con ventas pendientes y ALL OUT para evitar sobreventa; confirmar con el bróker la cantidad realmente cerrada.
- Comprobar si TradeStation permite alojar la protección necesaria para cada instrumento y cuenta. Si depende del servidor, debe funcionar sin el navegador abierto y mostrar explícitamente cualquier pérdida de cotizaciones o protección. No presentar un stop como activo sin verificar su estado.
- El 30% es un umbral de activación, no una pérdida máxima garantizada: el precio de cierre MARKET puede ser peor, especialmente tras interrupciones o movimientos bruscos.

### Scale-outs y trailing

- Una única barra opera sobre la posición seleccionada. Sus siete botones son **30%, 20%, 10%, 10%, 10%, 10%, 10%**. Cada botón es una instrucción independiente; los cinco botones de 10% tienen identidades distintas y cada uno se usa una vez por posición.
- Los porcentajes se calculan sobre la cantidad original comprada y confirmada. Conciliar fills parciales y remanentes de la entrada antes de fijar esa base para las salidas; no calcular cada porcentaje sobre la cantidad que queda.
- Usar redondeo acumulativo: calcular el objetivo correspondiente al porcentaje acumulado, restar la cantidad ya vendida o comprometida y limitar al remanente disponible. Para contratos enteros, el objetivo es `round(cantidad original × porcentaje acumulado / 100)`; para acciones respetar su incremento admitido.
- Serializar y persistir las intenciones de salida. Mientras una orden está pendiente, mostrar ese estado y evitar que el mismo botón vuelva a enviar otra orden. Resolver rechazos o cancelaciones con el bróker antes de volver a habilitar una acción.
- ALL OUT cierra el remanente confirmado de la posición seleccionada, coordinado con órdenes de venta y protecciones pendientes. Cada posición conserva su propia base, botones utilizados, fills y protección.
- El cliente puede configurar el **porcentaje de trailing**, con **10% inicial**, al activarlo para la posición seleccionada. Validar el porcentaje en servidor. El cliente no puede cambiar el umbral de ventas que permite activarlo.
- El **umbral vendido para habilitar trailing** empieza en **70%** y lo configura el administrador por cliente. Guardar el umbral aplicable con la posición; como criterio inicial, los cambios administrativos se aplican a nuevas posiciones.
- Habilitar ACTIVATE TRAILING únicamente cuando `cantidad vendida confirmada / cantidad original >= umbral / 100` y quede remanente. Los clics, porcentajes solicitados y ventas pendientes no acreditan el umbral. Con cantidades pequeñas, el redondeo puede impedir alcanzar el umbral conservando remanente; mostrar la elegibilidad real.
- La activación es manual, como en el demo. Al activarse, tomar una cotización vigente y ejecutable del instrumento; seguir el máximo favorable desde ese momento y actualizar el umbral de cierre según el porcentaje elegido. El trailing protege exclusivamente el remanente y su nivel de protección no retrocede.
- Coordinar trailing, stop inicial y cierre manual mediante el mismo control de cantidades. El trailing no debe debilitar el stop inicial ni duplicar ventas. Un cierre por trailing es una salida y no consume una entrada diaria.
- Mostrar porcentaje elegido, ventas confirmadas, umbral de habilitación y estado real de protección. Validar con TradeStation qué protección puede residir en el bróker y cuál depende del servidor; no presentar un simple cambio de estado visual como protección activa.

### Cadena de opciones

Buscar el ticker del subyacente, seleccionar vencimiento y consultar CALL/PUT por strike. Mostrar bid/ask y el estado o antigüedad de los datos disponibles. Al seleccionar una opción, conservar el símbolo exacto que reconoce TradeStation y mostrar subyacente, vencimiento, strike y CALL/PUT en el resumen de la orden. No confundir el ticker del subyacente con el símbolo del contrato.

El selector de fecha del demo (`expiry`, «Vencimiento») corresponde al vencimiento de la opción elegida por el cliente. En la aplicación, ofrecer vencimientos disponibles en la cadena de TradeStation. Esta fecha identifica el contrato; no programa por sí sola una orden de cierre. Las acciones no utilizan ese campo de vencimiento.

La prima de referencia proviene exclusivamente de las cotizaciones de la API de TradeStation para el contrato seleccionado. Mostrar bid/ask y su actualización, sin input editable ni valor manual de respaldo. Al cambiar de contrato, quitar la cotización anterior hasta disponer de datos del nuevo símbolo. Si faltan datos o están desactualizados, mostrar ese estado explícitamente.

Los precios de la cadena sirven de referencia; una orden de mercado no fija el precio de ejecución. La prima media realmente ejecutada se obtiene de los fills confirmados por TradeStation. La disponibilidad de cadena y cotizaciones depende de los permisos de datos de la conexión y debe comprobarse con el acceso existente.

### Operaciones y horario

- Abrir posiciones largas mediante compra y reducirlas o cerrarlas mediante venta. Rechazar aperturas en corto, SELL TO OPEN y operaciones que necesiten una posición corta previa.
- Para una venta, comprobar la cantidad disponible y descontar las cantidades ya comprometidas en órdenes pendientes. El cierre parcial usa la barra porcentual sobre la base original; el cierre total usa el remanente verificado.
- Enviar órdenes solo durante la sesión regular válida para el instrumento. Validar en servidor calendario, zona horaria de mercado, festivos y cierres anticipados; no depender del reloj del navegador.
- Consultar posiciones, estados e historial también fuera de sesión. Una cancelación debe reflejar la confirmación del bróker; solicitarla no garantiza que una orden MARKET no haya sido ejecutada ya.

### Permanencia de posiciones entre sesiones

- Por decisión del usuario, permitir posiciones abiertas durante varias sesiones según la temporalidad elegida. No liquidarlas automáticamente al cierre diario del mercado.
- En opciones, conservar el vencimiento seleccionado junto con el contrato. La posición puede cerrarse antes por una salida manual, stop o trailing; seleccionar una fecha no garantiza mantenerla abierta hasta ese día. En acciones, mantener la posición hasta su cierre, sin imponer una fecha de vencimiento.
- Las posiciones que continúan abiertas siguen ocupando el máximo de dos plazas. El cambio de día renueva el cupo diario de nuevas entradas, pero no reinicia las posiciones, sus cantidades originales, scale-outs, SIZE aplicado, stop ni trailing.
- Mantener la regla de ejecución solo en sesión regular. Conservar el estado de las protecciones entre sesiones y verificar su continuidad y la conexión al reanudarse el mercado; no presentar permanencia de una posición como garantía de ejecución fuera de horario.
- Validar con TradeStation el tratamiento de opciones al vencimiento y reflejar sus eventos y posiciones resultantes. No marcar una posición como cerrada ni liberar su plaza únicamente porque llegó la fecha seleccionada; conciliar primero el estado del bróker. Esta comprobación forma parte de la integración antes de habilitar operaciones reales.

### Terminal y referencia visual

La [imagen de referencia proporcionada por el usuario](references/REEL_CAPITAL_VISUAL_REFERENCE.png) define la estética principal: interfaz oscura, monocromática, minimalista y casi brutalista. Los demos, especialmente el [terminal privado](references/REEL_CAPITAL_PRIVATE_TERMINAL.html), siguen como referencia de estructura e interacción: tarjetas de posiciones, selección visible, controles de cierre sobre la posición seleccionada, estado de conexión y registro de eventos.

#### Dirección visual confirmada

- Usar exclusivamente negro/carbón, grises neutros y blanco. La imagen prevalece sobre los acentos azules, verdes o rojos de los demos. Comunicar estados mediante texto, iconos, bordes y contraste, sin depender de colores de acento.
- Paleta inicial propuesta: fondo `#121212`, superficies `#1B1B1B`, separadores `#333333`, texto principal `#F5F5F5`, texto secundario `#B3B3B3` y controles principales blancos con texto oscuro.
- Fuente elegida: **IBM Plex Mono**, gratuita y de código abierto bajo SIL Open Font License 1.1, para terminal, acceso y administración. Su carácter monoespaciado encaja con la referencia minimalista y casi brutalista. Usar pesos 400, 500 y 600, números tabulares, etiquetas breves y cifras operativas destacadas; mantener legibilidad de textos secundarios y mensajes de riesgo. Servir los archivos web desde la aplicación, conservar la licencia y usar `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` como respaldo. Fuente oficial: [IBM Plex](https://github.com/IBM/plex).
- Retícula ordenada, separación generosa entre grupos y alineaciones precisas. Contenedores planos, bordes finos y esquinas discretas; evitar degradados, brillos, sombras decorativas y tarjetas excesivamente redondeadas.
- Botones sólidos o delineados. Indicar selección e interacción con inversión blanco/oscuro, borde visible y etiquetas; conservar foco de teclado claro. BUY y ALL OUT deben distinguirse por texto, ubicación y tratamiento visual aun dentro de la misma paleta.
- Iconos simples de trazo fino. La tipografía y la información operativa llevan el peso visual; no incorporar gráficos, símbolos cripto ni funciones de predicción presentes en la referencia estética.
- Aplicar el mismo lenguaje a invitaciones, acceso con passkey, panel de administración y terminal. Adaptar a computadora e iPad, con disposición apilada en pantallas pequeñas y objetivos táctiles de al menos 44 px.
- Mantener siempre legibles SIM/REAL, cuenta, conexión, límites diarios, posición seleccionada y estado de las protecciones. El minimalismo no debe ocultar información necesaria para confirmar una operación.

Mantener gráficos y P&L realizado/flotante ocultos durante la operación. El historial muestra órdenes, estados, cantidades y ejecuciones sin añadir P&L al terminal. No ocultar avisos de conexión, permisos o resultados desconocidos.

La referencia HTML es una simulación local. Sus funciones `TEST STOP` y `REINICIAR SESIÓN` no representan acciones del terminal conectado: un reinicio de interfaz no puede borrar órdenes, posiciones ni auditoría del bróker.

El campo editable «Prima de referencia» de los demos se sustituye en la aplicación por una cotización automática de solo lectura. Los archivos HTML se conservan como referencias originales; ese input no forma parte del formulario del MVP.

El MVP sustituye el SIZE DOWN del demo por un SIZE de US$20,000 por cliente, que únicamente el administrador puede aumentar. El terminal del cliente muestra ese valor y la cantidad de entrada calculada sin controles para editarlos. Los HTML se conservan como referencias originales; sus botones NORMAL/−25%/−50% no pasan a la aplicación.

Mostrar en el terminal el contador de entradas del día (`0 / 3` a `3 / 3`), el porcentaje de stop aplicable y el estado verificado de la protección. Sustituir el contador de dos stops del demo por el límite de tres entradas nuevas. El stop de 30% ya es parte del MVP y admite configuración del administrador.

El máximo de dos posiciones simultáneas, los siete botones de scale-out y el trailing manual son requisitos confirmados. Adaptar el demo para usar trailing inicial de 10%, bloqueo hasta alcanzar las ventas confirmadas requeridas (70% inicial) y estados derivados de TradeStation.

El criterio de éxito es enviar una orden autorizada y consultar su estado real. La aceptación de una orden no implica que ya esté ejecutada.

## Autenticación con TradeStation

La API key identifica la aplicación (`client_id`). TradeStation documenta un flujo Authorization Code: el cliente se autentica directamente en el bróker, autoriza la aplicación y el backend intercambia el código por tokens. El flujo estándar requiere también el secreto de la aplicación. Una API key aislada no basta para operar una cuenta.

El cliente verá la autorización de TradeStation al conectar y cuando necesite autenticarse de nuevo. Después puede operar desde REEL CAPITAL mientras su conexión siga autorizada.

Conexión confirmada: API propia por cliente. Configurar sus credenciales compatibles, callbacks y autorización OAuth. Recibir una clave no garantiza que esté configurada para nuestro dominio. Si requiere un secreto, recibirlo y almacenarlo cifrado mediante el backend.

TradeStation documenta restricciones de acceso por login en las API keys. Verificar para cada conexión sus callbacks autorizados, logins, cuentas y permisos. El usuario confirma disponer de API key y SIM y aporta la comunicación de aprobación de su Web API key; todavía no se han probado sus permisos ni su configuración desde esta aplicación.

La API propia puede utilizarse con SIM y, posteriormente, real cuando su configuración y permisos lo permitan. Asociar cada conexión OAuth con el cliente, la aplicación API que la autorizó y sus cuentas habilitadas; no mezclar tokens entre aplicaciones API.

### Condiciones de la API key aprobada y continuidad de conexión

Según la [comunicación de aprobación aportada por el usuario](references/TRADESTATION_API_APPROVAL.md), la clave aprobada utiliza Auth0 y admite endpoints API v2 y v3, pero **la autenticación y la generación de access tokens deben realizarse mediante los endpoints de autenticación v3**. Adoptar v3 para la integración inicial. Auth0 identifica el proveedor de autenticación; se mantiene el flujo OAuth descrito arriba. Esta aprobación corresponde a la clave del aviso y no acredita automáticamente las claves de futuros clientes.

- Tratar `client_id`, secreto, access tokens y refresh tokens como credenciales de la conexión. Gestionarlos en el servidor y guardar secretos y tokens cifrados; no incluirlos en Git, registros ni respuestas al navegador. El `client_id` puede aparecer en la redirección OAuth exigida por el proveedor; el secreto y los tokens no deben exponerse por esa vía.
- El aviso indica que los suscriptores profesionales de datos pueden tener refresh tokens con caducidad por defecto. **Cuando la conexión usa refresh tokens con caducidad, su vida absoluta es de 24 horas y requiere reautenticación manual dentro de ese plazo.** Renovar un access token no sustituye esa reautenticación ni permite prolongar indefinidamente el plazo absoluto.
- No asumir que todas las conexiones caducan a las 24 horas ni que la clave aprobada tiene necesariamente esa configuración. Verificar la política efectiva por conexión y conservar solo los metadatos necesarios de autenticación y vencimiento. Si el plazo no está confirmado, mostrarlo como desconocido en lugar de inventar una cuenta regresiva.
- Supervisar la conectividad de todos los clientes, independientemente de su política de refresh tokens. Renovar access tokens de forma coordinada por conexión mientras sea posible; si se conoce un vencimiento absoluto, avisar con antelación y facilitar «Reconectar con TradeStation» antes de que interrumpa la sesión operativa. La passkey de REEL CAPITAL no sustituye esta autorización del bróker.
- Si caducan o se revocan las credenciales, fallan las renovaciones o se pierde la conexión necesaria, bloquear nuevas entradas y mostrar la acción requerida. No declarar activas las protecciones que no puedan verificarse. Una protección ejecutada por nuestro servidor puede dejar de poder enviar el cierre al perder autorización; las órdenes ya alojadas en el bróker deben verificarse por separado. Mantener los cierres disponibles cuando la conexión todavía permita ejecutarlos, sin prometer que una solicitud sin autorización llegará al bróker.
- Tras reconectar, conciliar órdenes, ejecuciones, posiciones y protecciones antes de habilitar nuevas entradas o reenviar acciones con resultado desconocido. La reconexión no borra los contadores diarios, las reservas ni el estado de scale-outs.

## Modos SIM y real

- **SIM:** modo inicial y predeterminado, conectado al simulador de TradeStation. Un adaptador local para desarrollo debe identificarse como simulación local, distinto del SIM del bróker.
- **Real:** contemplado para una etapa posterior. Debe permanecer deshabilitado en servidor hasta completar la integración y habilitar las cuentas correspondientes; ocultar un botón no basta.
- Vincular cada orden al cliente, conexión, cuenta y modo antes de enviarla. El servidor valida esa combinación y selecciona un endpoint autorizado; el navegador no proporciona una URL arbitraria del bróker.
- Separar órdenes, posiciones, identificadores de idempotencia y bitácora por modo. Validar credenciales y permisos por entorno sin asumir que cambiar el endpoint habilita operaciones reales.
- Al cambiar de modo, descartar el formulario de orden sin enviar y cargar las cuentas, posiciones y órdenes del modo seleccionado. El cambio no envía ni cancela órdenes pendientes en el otro modo.

## Arquitectura propuesta

| Componente | Tecnología | Función |
| --- | --- | --- |
| Lógica y validación | TypeScript + Effect | Validar entradas con Schema, manejar errores y coordinar operaciones con el bróker. |
| Interfaz y rutas de aplicación | SvelteKit | Configurar API propia, seleccionar SIM/real, operar acciones, consultar cadenas de opciones y preparar órdenes de mercado. |
| Backend | Effect en rutas de servidor de SvelteKit sobre Cloudflare Workers | Gestionar OAuth y sesiones, autorizar solicitudes y ejecutar la lógica de negocio. |
| Autenticación de la aplicación | Better Auth sobre Workers con D1 | Passkeys, verificación de correo, sesiones, roles y recuperación; integrar el acceso por invitación y mantenerlo separado del OAuth de TradeStation. |
| Datos de clientes | Cloudflare D1 | Usuarios, sesiones, SIZE, stop loss y umbral de habilitación de trailing por cliente con auditoría de cambios y conexiones autorizadas; secretos API y tokens individuales almacenados cifrados. |
| Coordinación de órdenes | Durable Objects con SQLite | Un objeto por cliente y modo: órdenes por cuenta, idempotencia, capacidad/reservas diarias, posiciones, base y botones de scale-out, stops, trailing y recuperación. |
| Secretos de aplicación | Workers Secrets | Claves de cifrado y secretos propios de REEL CAPITAL; las credenciales API individuales se guardan cifradas en la persistencia. |
| Adaptador y desarrollo | `@sveltejs/adapter-cloudflare` + Wrangler | Integrar SvelteKit con Workers y sus bindings; comprobar el backend también en el runtime de Workers. |

Un solo proyecto inicial. D1 guarda identidad, configuración y conexiones; el Durable Object conserva el registro operativo del cliente en cada modo, con separación interna por cuenta. Centralizar ahí las reservas y el contador diario impide eludir el límite usando varias cuentas o pestañas. Evitar duplicar estados de órdenes entre ambos almacenes. Coordinar la renovación de tokens por conexión, incluso si habilita varias cuentas.

Usar las rutas de servidor de SvelteKit para las operaciones de la aplicación y Effect para validación, servicios y errores. Mantener credenciales e integración con TradeStation en módulos exclusivos de servidor. Acceder a los servicios de Cloudflare mediante los bindings del adaptador; fijar y verificar versiones compatibles al crear la base del proyecto.

Mantener una sesión propia de REEL CAPITAL con cookies seguras y protección CSRF, asociada a un perfil activo creado por el administrador. Validar cualquier identidad OIDC de TradeStation antes de vincularla al perfil; un callback OAuth no crea ni activa clientes por sí solo. Cloudflare Access queda como opción para herramientas internas; el acceso de clientes requiere sesiones y autorización de la aplicación.

## Reglas técnicas del MVP

- Obtener el cliente de la sesión verificada y comprobar la pertenencia de cada cuenta y orden. No confiar en identificadores de cliente enviados por el navegador.
- Mantener secretos y tokens del bróker en servidor, fuera del navegador y los registros.
- Obtener cotizaciones del bróker para el instrumento exacto; no aceptar una prima enviada por el navegador como fuente de precio ni como confirmación de ejecución.
- Calcular en servidor la cantidad de entrada desde el SIZE autorizado del cliente y la cotización del bróker. No aceptar SIZE ni cantidades de entrada arbitrarias del navegador. Coordinar los aumentos administrativos con la preparación y persistir qué configuración se aplicó a cada orden.
- Validar símbolo de acción o contrato de opción, cantidad con su unidad correcta, instrucción de compra o venta, cuenta, permisos y condiciones antes de enviar. Comprobar en servidor que el instrumento pertenece al alcance admitido y que la operación es compatible con la cuenta y su posición existente.
- Aplicar en servidor el acceso por perfil activo, compra para abrir/venta para cerrar y sesión regular. Rechazar ventas que excedan la posición disponible, incluso ante solicitudes concurrentes.
- Hacer cumplir las dos posiciones simultáneas y las tres entradas diarias mediante reservas persistentes. Aplicar el stop y el umbral de habilitación de trailing guardados para cada posición. Los límites de entrada no deben impedir cancelar o cerrar posiciones.
- Validar que el SIZE inicial sea US$20,000, que solo un administrador pueda aumentarlo, que el aumento afecte únicamente al cliente elegido y que cualquier reducción sea rechazada. Comprobar dimensionamiento y redondeo para acciones y opciones, cotizaciones ausentes y cantidades inferiores al mínimo.
- Aceptar exclusivamente órdenes de mercado en el servidor. Rechazar solicitudes con otros tipos de orden aunque se envíen fuera del formulario.
- Persistir un identificador por intención de orden. Repetir la solicitud por doble clic o fallo de red no debe crear otra orden; una orden nueva recibe otro identificador.
- Coordinar transiciones y cantidades de forma atómica. Un Durable Object puede intercalar solicitudes durante operaciones asíncronas; usarlo no elimina por sí solo las carreras.
- Diferenciar envío, aceptación, ejecución parcial, ejecución completa, cancelación, rechazo y resultado desconocido.
- Ante un envío sin respuesta, reconciliar con el bróker antes de reenviar. No repetir compras o ventas mediante reintentos ciegos de Effect.
- Consultar órdenes y posiciones al recuperar la sesión; contemplar operaciones realizadas desde otros terminales.
- Mostrar desconexiones y errores comprensibles. No mostrar ejecución sin confirmación del bróker.
- Separar SIM y real en interfaz, autorización, persistencia y configuración. Lanzar en SIM y habilitar real en una etapa posterior según la decisión confirmada del usuario.
- Probar invitaciones y permisos de perfiles, aislamiento entre clientes y modos, contrato exacto de la cadena, compra y cierre de acciones/opciones, cierres parciales/totales, cancelación simultánea con fills, horario regular, rechazo de shorts y tipos de orden no admitidos, entradas inválidas, duplicados, token vencido y resultados desconocidos antes de incorporar clientes.
- Probar límite de tres con compras concurrentes y varias cuentas, cancelación/rechazo sin fills, fills parciales, cierre y reentrada, resultados desconocidos, reinicios y cambio de sesión de mercado. Para stops: porcentaje administrativo, cálculo desde fills, cantidad remanente, cotización ausente, desconexión del navegador y carreras entre stop y cierre manual.
- Probar límite de dos posiciones con aperturas/cierres concurrentes, redondeo acumulado con cantidades impares, botones de 10% independientes, selección de posición, habilitación de trailing por fills reales, umbral configurable por administrador, porcentaje configurable por cliente y carreras entre trailing, stop y ALL OUT.
- Probar que ningún cliente ni administrador puede omitir MFA; rechazar invitaciones/códigos vencidos o reutilizados, autenticaciones con origen incorrecto y recuperación que intente quitar factores sin validación. Verificar revocación de sesiones y continuidad de protecciones al cerrar sesión.

## Primera entrega propuesta

El administrador crea un perfil con SIZE inicial de US$20,000 y el cliente de prueba activa su acceso por invitación, configura su API propia y conecta una cuenta autorizada de TradeStation SIM. Durante sesión regular, completa dos recorridos: compra MARKET de una acción y BUY TO OPEN MARKET de un contrato seleccionado desde la cadena, ambos con cantidad calculada automáticamente desde su SIZE y cotización API. Consulta las ejecuciones, cierra parcial o totalmente sus posiciones y recupera el historial al volver a entrar. Comprueba cancelación de órdenes pendientes cuando el bróker todavía permite cancelarlas. Gráficos y P&L permanecen ocultos en el terminal.

El administrador aumenta el SIZE de un cliente y la siguiente entrada usa el nuevo importe. El SIZE de otro cliente y las órdenes ya enviadas conservan su valor. Verificar que el cliente no puede alterar SIZE ni cantidad de entrada y que tampoco se admiten reducciones administrativas.

Tras tres entradas nuevas en una sesión, una cuarta compra se rechaza incluso desde otra cuenta o pestaña del mismo cliente y modo. Los cierres siguen disponibles. Una posición usa stop de 30% por defecto y las nuevas posiciones reflejan el porcentaje que configure el administrador. Verificar que el stop actúa sobre el remanente y que su estado persiste tras reconexiones.

Con dos posiciones abiertas, una tercera apertura se rechaza. La barra porcentual afecta solo a la posición seleccionada. Tras ventas confirmadas suficientes, el cliente puede activar trailing con 10% inicial o el porcentaje que elija. Una orden de salida pendiente no habilita trailing; un cambio administrativo de stop no modifica posiciones abiertas.

La prima se carga desde la API al seleccionar el contrato y no puede editarse. Comprobar que cambiar de contrato no conserva su cotización anterior y que la falta de datos se muestra explícitamente. El precio confirmado de ejecución debe provenir de los fills, no de la prima de referencia.

Otro cliente no puede leer sus datos, usar sus credenciales ni operar su cuenta. El servidor rechaza registro no invitado, órdenes reales en esta etapa, aperturas en corto, instrumentos fuera del alcance, órdenes fuera de sesión regular y tipos de orden distintos de MARKET.

Construcción: base SvelteKit/Effect/Workers → perfiles de administrador/cliente e invitaciones → configuración API por cliente y OAuth → terminal monocromático según la imagen, con flujo de los demos y cadena de opciones → compra, cierre, cancelación e historial → conciliación y validación con el SIM disponible → piloto privado → habilitación posterior del modo real. Un adaptador local permite reproducir fallos, pero no acredita la integración con TradeStation.

Validar la fuente de cotizaciones y eventos necesaria para stop y trailing. TradeStation dispone de streams HTTP; si se usan, comprobar reconexiones, fragmentación y recuperación tras reinicios. La implementación y residencia de ambas protecciones requieren validación con la API disponible.

## Documentos existentes

- [Informe para el programador](references/REEL_CAPITAL_Informe_Para_Programador.pdf).
- [Proyecto integral](references/REEL_CAPITAL_Proyecto_Integral.pdf).
- [Demo HTML](references/REEL_CAPITAL_DASHBOARD_DEMO.html).
- [Referencia del terminal privado aportada en la conversación](references/REEL_CAPITAL_PRIVATE_TERMINAL.html).
- [Referencia visual principal: terminal oscuro monocromático](references/REEL_CAPITAL_VISUAL_REFERENCE.png).
- [Comunicación de aprobación de la Web API key de TradeStation](references/TRADESTATION_API_APPROVAL.md).

Las decisiones de esta conversación prevalecen sobre los PDFs: aplicación para clientes invitados, acciones y opciones con API propia, compra para abrir y venta para cerrar, órdenes de mercado y horario regular. El SIZE empieza en US$20,000 por cliente y solo admite aumentos del administrador; la cantidad de entrada se calcula desde la cotización API. Se permiten dos posiciones abiertas y tres entradas diarias. El stop inicial de 30% admite cambios administrativos solo para nuevas posiciones. Se adoptan los scale-outs del demo y trailing manual de 10% ajustable por cliente, habilitado tras vender 70% inicial con umbral configurable por administrador. Gráficos y P&L permanecen ocultos. TypeScript + Effect sustituye la propuesta de Python/FastAPI.

## Preparación para implementar

El alcance principal del onboarding queda definido. Dominio de la aplicación: `thereelcapital.com`, confirmado por el usuario, con cuenta Cloudflare disponible. Piloto por invitación con unos pocos clientes iniciales. Mantener las credenciales fuera de la conversación y de Git; configurarlas mediante el entorno de desarrollo y el almacenamiento de secretos correspondiente.

Comprobar con las credenciales disponibles los endpoints de autenticación v3, callbacks OAuth, cuentas SIM, permisos de datos de acciones y opciones y política efectiva de caducidad de refresh tokens. Antes del piloto, verificar renovación, aviso previo cuando corresponda, caducidad/revocación, reautenticación manual y conciliación posterior, incluido su efecto sobre stops y trailing. La aprobación y disponibilidad de credenciales están confirmadas por el usuario; la conectividad operativa y la política de caducidad de esta conexión todavía no están verificadas.

Para implementar, configurar invitaciones y verificación de correo, passkeys con verificación de usuario, recuperación, callback OAuth y vigencia de órdenes compatible con MARKET durante sesión regular. Antes del piloto, fijar presupuesto operativo y retención de datos. Estas decisiones técnicas no cambian el alcance principal acordado ni requieren reabrir las preguntas ya respondidas.

## Decisiones posteriores (20 de octubre de 2026)

Respuestas del usuario a las preguntas abiertas de `docs/open-questions.md`. Se distinguen las decisiones confirmadas de las propuestas pendientes.

- **Scale-out que redondea a cero (confirmado):** igual que el demo. El botón queda marcado como usado y su porcentaje se suma al objetivo acumulado, pero no se envía una orden de cantidad cero. Mostrar «0 contratos por redondeo». Esto no aumenta el porcentaje realmente vendido a efectos de habilitar el trailing.
- **Porcentaje de trailing:** confirmado que el cliente lo ajusta, con 10% inicial. *Propuesto, no confirmado:* conservar las opciones del demo: 1%, 5%, 8%, 10%, 15% y 20%.
- **Límites del stop y del umbral de trailing:** el servidor aplica un mínimo y un máximo. Valores por defecto confirmados: stop 30% y 70% vendido de la cantidad original para habilitar el trailing, configurables por cliente. *Pendiente:* los valores mínimo y máximo.
- **Aumentar una posición existente:** la regla de conteo está definida: cada compra intencional adicional consume una entrada diaria al recibir su primer fill; los fills parciales y los reintentos de la misma orden no consumen entradas adicionales. *Pendiente:* cómo afecta un aumento a la cantidad original, los scale-outs, el precio medio de entrada y las protecciones.
- **Retención del historial:** *pendiente* el plazo. Órdenes, ejecuciones, eventos operativos y auditoría administrativa deben persistir entre sesiones.
- **Revisión técnica de la arquitectura propuesta:**
  - Un Durable Object **por cliente**, en lugar de uno por cliente y modo. Cada registro, contador e identificador sigue separado por modo, y ese objeto es el único que se comunica con TradeStation para el cliente.
  - El Durable Object reside en un segundo Worker del mismo repositorio, porque el adaptador de SvelteKit no permite exportarlo.
  - Detalle en `docs/decisions.md` (T1–T13).
- **Tipografía, panel de administración y Better Auth:** confirmados; ver [Dirección visual confirmada](#dirección-visual-confirmada), [Panel de administración completo](#panel-de-administración-completo) y [Autenticación y recuperación](#autenticación-y-recuperación). *Pendiente:* el proveedor de envío de correo para invitaciones y códigos.

## Fuentes técnicas

- [Better Auth: código fuente y licencia MIT](https://github.com/better-auth/better-auth).
- [Better Auth: ejemplo SvelteKit](https://better-auth.com/docs/examples/svelte-kit).
- [Better Auth: soporte de Cloudflare D1](https://better-auth.com/blog/1-5).
- [Better Auth: passkeys](https://better-auth.com/docs/plugins/passkey).
- [Better Auth: Email OTP](https://better-auth.com/docs/plugins/email-otp).
- [Better Auth: 2FA y códigos de respaldo](https://better-auth.com/docs/plugins/2fa).
- [Better Auth: administración](https://better-auth.com/docs/plugins/admin).
- [NIST: autenticadores y autenticación multifactor](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/).
- [TradeStation: Authorization Code](https://api.tradestation.com/docs/fundamentals/authentication/auth-code/).
- [TradeStation: configuración de API keys y acceso a cuentas](https://api.tradestation.com/docs/fundamentals/authentication/auth-overview/).
- [TradeStation: entorno SIM](https://api.tradestation.com/docs/fundamentals/sim-vs-live/).
- [TradeStation: streaming HTTP](https://api.tradestation.com/docs/fundamentals/http-streaming/).
- [Effect: documentación](https://effect.website/docs/getting-started/introduction/).
- [SvelteKit: adaptador Cloudflare](https://svelte.dev/docs/kit/adapter-cloudflare).
- [Cloudflare: SvelteKit en Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/svelte/).
- [Cloudflare: almacenamiento de Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

Este documento fija el onboarding. La autenticación, la integración operativa y el aislamiento entre clientes todavía no están implementados ni probados.
