export type PaymentPreferences = {
    /** Maximum monthly payment target (dollars). Matches PaymentExtractor output field. */
    maxMonthlyPayment?: number;
    /** Legacy alias — retained for compatibility, prefer maxMonthlyPayment */
    maxMonthly?: number;
    apr?: number;
    termMonths?: number;
    downPayment?: number;
};
