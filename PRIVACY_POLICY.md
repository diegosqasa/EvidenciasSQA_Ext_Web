Política de Privacidad — Extensión Web Evidencias SQA

Versión de la extensión: 4.1.1
 Última actualización: 2026-09-05
 Responsable: Evidencias SQA

1. Finalidad de la extensión

Evidencias SQA es una herramienta diseñada para capturar, organizar y gestionar evidencias de pruebas de software.

Permite a los analistas de calidad (QA) capturar contenido visual, agregar anotaciones esenciales y asociar cada evidencia a Historias de Usuario (HU) y Casos de Prueba (CP), facilitando la documentación, trazabilidad y generación de reportes de aseguramiento de calidad.

La extensión funciona únicamente cuando el usuario inicia una captura de manera explícita.

2. Datos que se capturan

La extensión procesa únicamente la información necesaria para generar evidencias:

Imagen capturada por el usuario (PNG).
URL de la página capturada.
Título de la página capturada.
Fecha y hora de captura.
Navegador y versión.
Sistema operativo.

La extensión no recopila:

Historial de navegación.
Contraseñas.
Cookies.
Información financiera.
Información médica.
Pulsaciones de teclado.
Analítica de uso.
Telemetría de terceros.
Información para publicidad.
3. Dónde se almacenan los datos

Toda la información permanece en el dispositivo del usuario.

Almacén	Contenido	Retenciónchrome.storage.local	Token temporal de autenticación y configuración básica	Temporal
IndexedDB (SQAOfflineDB)	Capturas pendientes de sincronización cuando la aplicación no está disponible	Hasta sincronización exitosa
Memoria temporal del Service Worker	Datos utilizados durante una captura activa	Temporal

Las capturas no se almacenan en servidores externos.

4. Comunicación con la aplicación de escritorio

La extensión se comunica únicamente con la aplicación local Evidencias SQA ejecutándose en el mismo equipo mediante:

http://127.0.0.1:3000


Esta comunicación se utiliza para:

Transferir capturas realizadas por el usuario.
Sincronizar capturas pendientes.
Consultar el estado de la aplicación local.
Obtener tokens temporales de autenticación.

No se utilizan cookies.

No se envían credenciales a servicios externos.

No se comparte información con terceros.

5. Permisos utilizados
activeTab

Permite capturar el contenido visible de la pestaña activa cuando el usuario inicia una captura.

tabs

Permite obtener la URL y el título de la pestaña capturada para generar metadatos de la evidencia.

scripting

Permite inyectar temporalmente la lógica necesaria para realizar capturas de página completa, capturas de área y procesamiento de contenido.

clipboardWrite

Permite copiar una captura al portapapeles únicamente cuando el usuario lo solicita explícitamente.

storage

Permite almacenar configuraciones locales y tokens temporales necesarios para el funcionamiento de la extensión.

unlimitedStorage

Permite almacenar temporalmente capturas pendientes cuando la aplicación de escritorio no está disponible.

host_permissions <all_urls>

Evidencias SQA es una herramienta de captura utilizada en:

Sitios públicos.
Intranets corporativas.
Ambientes de pruebas.
Ambientes de staging.
localhost.
Documentos PDF.

El permiso <all_urls> permite ejecutar las funciones de captura y procesamiento en cualquier sitio que el usuario decida capturar.

La extensión no realiza seguimiento de navegación ni monitoreo de actividad del usuario.

6. Captura de documentos PDF y archivos locales

La extensión puede capturar documentos PDF abiertos por el usuario.

Cuando el usuario habilita expresamente el acceso a URLs de archivo (file://) desde la configuración del navegador, la extensión puede procesar dichos documentos para generar la evidencia solicitada.

No existe acceso automático a archivos locales fuera de una acción explícita iniciada por el usuario.

7. Uso de los datos

Los datos procesados por la extensión se utilizan exclusivamente para:

Generar evidencias visuales.
Asociar evidencias a Historias de Usuario y Casos de Prueba.
Facilitar la documentación de pruebas.
Generar reportes de aseguramiento de calidad.
Sincronizar capturas con la aplicación de escritorio Evidencias SQA.

Los datos no se utilizan para:

Publicidad.
Marketing.
Analítica.
Perfilamiento de usuarios.
Venta de información.
8. Compartición de datos

Evidencias SQA no vende, comparte ni transfiere datos de usuarios a terceros.

Toda la información permanece:

En el dispositivo del usuario.
En la extensión.
En la aplicación local Evidencias SQA.

No existen integraciones con servicios publicitarios ni plataformas de analítica.

9. Seguridad

La comunicación entre la extensión y la aplicación Evidencias SQA se realiza exclusivamente mediante localhost:

127.0.0.1


Los tokens utilizados para la comunicación son temporales y se renuevan automáticamente.

La extensión no acepta conexiones desde sitios externos.

10. Eliminación de datos

Al desinstalar la extensión:

Se eliminan los datos almacenados por la extensión en chrome.storage.local.
Se elimina la base de datos local IndexedDB asociada a la extensión.

Las capturas ya almacenadas por la aplicación de escritorio se gestionan conforme a la política de dicha aplicación.

11. Contacto

Si tienes preguntas relacionadas con privacidad o tratamiento de datos:

Evidencias SQA
 Sitio web: https://evidenciassqa.com

Privacy Disclosure

Evidencias SQA no recopila datos para publicidad, analítica ni seguimiento de usuarios.

Las capturas se generan únicamente bajo acción explícita del usuario y permanecen almacenadas localmente en el dispositivo.

La extensión se comunica exclusivamente con la aplicación Evidencias SQA ejecutándose localmente mediante 127.0.0.1.

No se comparten ni venden datos de usuarios a terceros.

Single Purpose

Evidencias SQA ayuda a equipos de aseguramiento de calidad (QA) a capturar, organizar y documentar evidencias visuales de pruebas, vinculándolas a Historias de Usuario y Casos de Prueba para generar reportes estandarizados y mejorar la trazabilidad de las validaciones realizadas.