import prisma from '../src/utils/prisma';

async function seed() {
  console.log('Seeding database...');

  // Create sample passenger
  const passenger = await prisma.user.upsert({
    where: { phone: '09120000001' },
    create: {
      phone: '09120000001',
      firstName: 'علی',
      lastName: 'احمدی',
      role: 'PASSENGER',
    },
    update: {},
  });
  console.log('Passenger created:', passenger.id);

  // Create sample driver
  const driver = await prisma.user.upsert({
    where: { phone: '09120000002' },
    create: {
      phone: '09120000002',
      firstName: 'رضا',
      lastName: 'محمدی',
      role: 'DRIVER',
    },
    update: {},
  });

  await prisma.driverStatus.upsert({
    where: { userId: driver.id },
    create: {
      userId: driver.id,
      isOnline: true,
      isAccepting: true,
      isOnTrip: false,
      latitude: 35.7219,
      longitude: 51.3347,
    },
    update: {},
  });
  console.log('Driver created:', driver.id);

  console.log('Seed complete');
  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});