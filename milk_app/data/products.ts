import { images, type AssetSource } from '@/constants/assets';

export type ProductCategory =
  | 'Milk'
  | 'Curd'
  | 'Paneer'
  | 'Ghee'
  | 'Butter'
  | 'Buttermilk'
  | 'Lassi';

export type Product = {
  id: string;
  name: string;
  size: string;
  price: number;
  mrp?: number;
  rating: number;
  reviews: number;
  category: ProductCategory;
  image: AssetSource;
  /** 'pack' artwork is transparent; 'tile' artwork carries its own cream backdrop. */
  imageKind: 'pack' | 'tile';
  tag?: string;
  farm: string;
  description: string;
  featured: boolean;
  nutrition: { label: string; value: string }[];
};

export const products: Product[] = [
  {
    id: 'a2-cow-milk',
    name: 'A2 Cow Milk',
    size: '1 Litre',
    price: 56,
    mrp: 64,
    rating: 4.8,
    reviews: 1245,
    category: 'Milk',
    image: images.bottleA2,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Green Valley Farms',
    description:
      'Creamy, easy-to-digest A2 milk from free-grazing indigenous cows. Bottled fresh at sunrise and delivered in insulated crates.',
    featured: true,
    nutrition: [
      { label: 'Protein', value: '3.4 g' },
      { label: 'Fat', value: '4.2 g' },
      { label: 'Calcium', value: '125 mg' },
    ],
  },
  {
    id: 'buffalo-milk',
    name: 'Buffalo Milk',
    size: '1 Litre',
    price: 62,
    rating: 4.7,
    reviews: 983,
    category: 'Milk',
    image: images.bottleBuffalo,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Sunrise Dairy Farm',
    description:
      'Rich, thick buffalo milk with naturally higher fat — perfect for chai, curd and festive sweets.',
    featured: true,
    nutrition: [
      { label: 'Protein', value: '3.8 g' },
      { label: 'Fat', value: '6.5 g' },
      { label: 'Calcium', value: '140 mg' },
    ],
  },
  {
    id: 'toned-milk',
    name: 'Toned Milk',
    size: '500 ml',
    price: 34,
    rating: 4.6,
    reviews: 743,
    category: 'Milk',
    image: images.bottleA2,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Green Valley Farms',
    description:
      'A light everyday milk with just the right creaminess. Pasteurised gently and never powdered.',
    featured: true,
    nutrition: [
      { label: 'Protein', value: '3.1 g' },
      { label: 'Fat', value: '3.0 g' },
      { label: 'Calcium', value: '120 mg' },
    ],
  },
  {
    id: 'buttermilk',
    name: 'Buttermilk',
    size: '500 ml',
    price: 28,
    rating: 4.6,
    reviews: 512,
    category: 'Buttermilk',
    image: images.categoryButtermilk,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Namma Farm Co.',
    description:
      'Cool, spiced chaas churned from fresh curd. A little ginger, curry leaf and a lot of refreshment.',
    featured: true,
    nutrition: [
      { label: 'Protein', value: '1.6 g' },
      { label: 'Fat', value: '1.2 g' },
      { label: 'Calcium', value: '85 mg' },
    ],
  },
  {
    id: 'paneer',
    name: 'Paneer',
    size: '200 gm',
    price: 80,
    rating: 4.9,
    reviews: 1102,
    category: 'Paneer',
    image: images.paneer,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Green Valley Farms',
    description:
      'Soft, hand-pressed paneer made this morning. Cloud-light cubes that hold their shape in the pan.',
    featured: true,
    nutrition: [
      { label: 'Protein', value: '18 g' },
      { label: 'Fat', value: '21 g' },
      { label: 'Calcium', value: '480 mg' },
    ],
  },
  {
    id: 'desi-ghee',
    name: 'Desi Ghee',
    size: '500 ml',
    price: 320,
    mrp: 380,
    rating: 4.9,
    reviews: 856,
    category: 'Ghee',
    image: images.gheeJar,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Village Aroma Co.',
    description:
      'Slow-churned, bilona ghee with a warm, nutty aroma. Made in small batches from grass-fed cow milk.',
    featured: true,
    nutrition: [
      { label: 'Protein', value: '0 g' },
      { label: 'Fat', value: '99 g' },
      { label: 'Calcium', value: '0 mg' },
    ],
  },
  {
    id: 'curd',
    name: 'Curd & Dahi',
    size: '400 gm',
    price: 48,
    rating: 4.8,
    reviews: 621,
    category: 'Curd',
    image: images.categoryCurd,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Namma Farm Co.',
    description:
      'Thick set curd with a gentle tang. Great with breakfast, or whisked into a cooling raita.',
    featured: false,
    nutrition: [
      { label: 'Protein', value: '4.2 g' },
      { label: 'Fat', value: '3.8 g' },
      { label: 'Calcium', value: '150 mg' },
    ],
  },
  {
    id: 'lassi',
    name: 'Lassi',
    size: '250 ml',
    price: 35,
    rating: 4.7,
    reviews: 410,
    category: 'Lassi',
    image: images.categoryLassi,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Namma Farm Co.',
    description:
      'A tall, chilled glass of sweet lassi — creamy, floral and made with fresh curd.',
    featured: false,
    nutrition: [
      { label: 'Protein', value: '3.2 g' },
      { label: 'Fat', value: '5.0 g' },
      { label: 'Calcium', value: '110 mg' },
    ],
  },
  {
    id: 'butter',
    name: 'Butter',
    size: '100 gm',
    price: 95,
    rating: 4.8,
    reviews: 388,
    category: 'Butter',
    image: images.categoryButter,
    imageKind: 'pack',
    tag: 'FARM FRESH',
    farm: 'Village Aroma Co.',
    description:
      'Churned white butter from fresh cream, with a pinch of salt and nothing else.',
    featured: false,
    nutrition: [
      { label: 'Protein', value: '0.8 g' },
      { label: 'Fat', value: '81 g' },
      { label: 'Calcium', value: '24 mg' },
    ],
  },
];

export const featuredProducts = products.filter((product) => product.featured);

export type CategoryChip = {
  key: 'All' | ProductCategory;
  label: string;
  image?: AssetSource;
};

export const productChips: CategoryChip[] = [
  { key: 'All', label: 'All' },
  { key: 'Milk', label: 'Milk', image: images.chipMilk },
  { key: 'Curd', label: 'Curd', image: images.chipCurd },
  { key: 'Paneer', label: 'Paneer', image: images.chipPaneer },
  { key: 'Ghee', label: 'Ghee', image: images.chipGhee },
  { key: 'Butter', label: 'Butter', image: images.chipButter },
  { key: 'Buttermilk', label: 'Buttermilk', image: images.categoryButtermilk },
  { key: 'Lassi', label: 'Lassi', image: images.categoryLassi },
];

export type HomeCategory = {
  key: 'all' | 'milk' | 'curd' | 'paneer' | 'ghee' | 'butter' | 'buttermilk' | 'lassi';
  label: string;
  image?: AssetSource;
  routeCategory?: ProductCategory;
};

export const homeCategories: HomeCategory[] = [
  { key: 'milk', label: 'Milk', image: images.categoryMilk, routeCategory: 'Milk' },
  { key: 'curd', label: 'Curd & Dahi', image: images.categoryCurd, routeCategory: 'Curd' },
  { key: 'paneer', label: 'Paneer', image: images.categoryPaneer, routeCategory: 'Paneer' },
  { key: 'ghee', label: 'Ghee', image: images.categoryGhee, routeCategory: 'Ghee' },
  { key: 'butter', label: 'Butter', image: images.categoryButter, routeCategory: 'Butter' },
  {
    key: 'buttermilk',
    label: 'Buttermilk',
    image: images.categoryButtermilk,
    routeCategory: 'Buttermilk',
  },
  { key: 'lassi', label: 'Lassi', image: images.categoryLassi, routeCategory: 'Lassi' },
  { key: 'all', label: 'View All' },
];

export const getProduct = (id: string) => products.find((product) => product.id === id);
