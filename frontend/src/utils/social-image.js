export const MAX_SOCIAL_IMAGE_BYTES = 6 * 1024 * 1024;

export function readSocialImage(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return Promise.reject(new Error('Elige una imagen JPG, PNG o WebP.'));
  }
  if (!file.size || file.size > MAX_SOCIAL_IMAGE_BYTES) {
    return Promise.reject(new Error('La imagen debe pesar entre 1 byte y 6 MB.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo. Vuelve a elegirlo.'));
    reader.onabort = () => reject(new Error('La lectura de la imagen se canceló.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}
