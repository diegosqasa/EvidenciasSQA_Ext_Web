# Evidencias SQA - Sistema de Gestión de Pruebas

Evidencias SQA es una herramienta robusta diseñada para capturar, editar y organizar evidencias visuales durante procesos de pruebas de software (SQA). Permite un flujo de trabajo ágil desde la captura inicial hasta la exportación por lotes.

## 🚀 Funcionalidades Principales

### 1. Gestión de Capturas
*   **Almacenamiento Local**: Utiliza **IndexedDB** para persistir imágenes de alta resolución sin depender de servidores externos.
*   **Versionado**: Al editar y guardar una captura, el sistema mantiene la original y genera una nueva versión, asegurando la trazabilidad.
*   **Metadatos en Header**: Cada captura incluye automáticamente en su cabecera (dibujado sobre la imagen) la URL de origen, fecha/hora, navegador, sistema operativo y resolución de pantalla.
*   **Thumbnails**: Generación automática de miniaturas para una navegación fluida en el historial.

### 2. Editor Avanzado (Canvas)
Potenciado por **Fabric.js**, el editor ofrece:
*   **Herramientas de Anotación**:
    *   **Flechas y Rectángulos**: Para señalar puntos críticos.
    *   **Texto**: Inserción de notas explicativas.
    *   **Resaltado**: Rectángulos semitransparentes para enfocar áreas.
    *   **Blur (Desenfoque)**: Para ocultar datos sensibles o PII.
*   **Herramientas de Ajuste**:
    *   **Recorte (Crop)**: Interfaz intuitiva para ajustar las dimensiones de la captura.
    *   **Zoom Dinámico**: Control preciso sobre el lienzo.
*   **Control de Propiedades**: Selector de color y ajuste de grosor de trazo (con debouncing para optimizar el rendimiento).
*   **Productividad**:
    *   Soporte completo para **Deshacer/Rehacer (Undo/Redo)**.
    *   Duplicación de objetos seleccionados.
    *   Atajos de teclado.

### 3. Visor de Evidencias
*   Visualización limpia y a pantalla completa.
*   Controles de navegación (Anterior/Siguiente).
*   Herramientas de zoom y ajuste automático al contenedor.
*   Acceso directo al editor y opciones de descarga/copiado.

### 4. Historial y Gestión por Lotes
*   **Explorador de Archivos**: Vista en cuadrícula con búsqueda por nombre o URL de origen.
*   **Modo Selección**:
    *   Gestión masiva de capturas.
    *   **Descarga ZIP**: Empaqueta múltiples capturas en un solo archivo usando **JSZip**.
    *   **Copiado al Portapapeles**: Permite copiar la imagen directamente para pegar en documentos o chats.
    *   **Eliminación Masiva**: Limpieza rápida del repositorio local.

### 5. Interfaz y Experiencia de Usuario
*   **Diseño Responsivo**: Barras de herramientas que se adaptan dinámicamente al tamaño de la pantalla.
*   **Transiciones Fluidas**: Cambio entre vistas (Historial, Visor, Editor) mediante layouts animados.
*   **Feedback Constante**: Sistema de notificaciones (Toasts) para confirmar acciones y diálogos de confirmación para acciones destructivas.

## 🛠️ Detalles Técnicos

*   **Lenguajes**: HTML5, CSS3 (Moderno/Flexbox), JavaScript (ES Modules).
*   **Bibliotecas**:
    *   `Fabric.js`: Manipulación avanzada del Canvas.
    *   `JSZip`: Generación de archivos comprimidos.
    *   `Lucide Icons`: Iconografía moderna y clara.
*   **Arquitectura**: Aplicación modular desacoplada en lógica de UI, lógica de base de datos y lógica de edición.
*   **Persistencia**: Client-side storage (IndexedDB) para máxima privacidad y velocidad.

## 📖 Instrucciones de Uso

1.  **Capturar**: Utiliza la extensión o el disparador para guardar una nueva imagen.
2.  **Ver**: Haz clic en cualquier elemento del historial para abrir el visor.
3.  **Editar**: Desde el visor, entra al editor para añadir anotaciones o recortar la imagen. Al "Guardar", se creará una copia editada.
4.  **Exportar**: En el historial, activa el modo selección, marca las capturas deseadas y descárgalas como ZIP para adjuntar a tus reportes de SQA.

---
*Desarrollado para optimizar la documentación de pruebas de calidad.*
