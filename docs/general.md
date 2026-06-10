# GENERAL Design Document

## Summary
Telegram bot for barber shop appointment management. Clients book appointments by selecting a master, service type, and available time slot, receiving a 1-hour pre-appointment reminder. Barbers view their daily schedule and mark completed visits. Designed for small to medium barber shops with multiple stylists.

## Core Entities
- **User**
  - Types: Client (regular user), Barber (specialized user)
  - Attributes: Telegram ID, name, contact info
  - Relationships: 
    - Clients create Appointments
    - Barbers own Appointments

- **Appointment**
  - Attributes: Start/end time, status (confirmed/completed)
  - Relationships:
    - Linked to one User (client)
    - Linked to one Barber
    - Linked to one Service
    - Triggers one Reminder

- **Service**
  - Attributes: Name, duration, price
  - Relationships: 
    - Available to multiple Barbers
    - Booked in Appointments

- **Reminder**
  - Attributes: Scheduled time, message content
  - Relationships: 
    - Generated from Appointments
    - Sent to Clients

- **BarberSchedule**
  - Attributes: Date, available time slots
  - Relationships: 
    - Owned by Barber
    - Contains Appointments

## External Dependencies
- **Telegram Bot API**: 
  - Inline keyboards for slot selection
  - Scheduled messages for reminders
  - User authentication via /start command
- **Database**: 
  - Persistent storage for Users, Appointments, Services, BarberSchedules
  - Required for appointment persistence across bot restarts
- **Time Management**: 
  - Timezone handling for reminders
  - Slot availability validation

## Feature List
- [Client] View available barbers and their services
- [Client] Select time slot from available barber's schedule
- [Client] Confirm appointment with payment (optional)
- [Client] Receive automated reminder 60 minutes before appointment
- [Barber] View daily schedule with appointment details
- [Barber] Mark completed appointments as "Done"
- [Barber] Set daily available time slots
- [Admin] Manage services (add/edit/delete)
- [System] Auto-cancel no-show appointments after 15 minutes
- [System] Generate daily summary report for barbers

## Non-Goals
- Payment processing integration
- Social media sharing of appointments
- Multi-location support
- Client rating system for barbers
- Voice assistant integration